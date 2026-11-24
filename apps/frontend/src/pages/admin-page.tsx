import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CampusMap } from '@/components/campus-map';
import { FilePicker } from '@/components/file-picker';
import { MapLayers } from '@/components/map-layers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { RangeSetting } from '@/components/range-setting';
import { Label } from '@/components/ui/label';
import { ClassDesk } from '@/components/class-desk';
import { toast } from '@/lib/toast';
import { api, ApiError } from '@/lib/api';
import { CLOUD_LIMITS, type AccessCode, type AppSettings, type Quiz, type Rarity, type Spawn, type StyleName } from '@/lib/types';
import { cn, formatWhen, RARITY_LABEL, RARITY_ORDER, UCR } from '@/lib/utils';

function tomorrowEvening() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(17, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fileName = (url: string) => url.split('/').pop() ?? '';

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---- Model library ------------------------------------------------------------------------------
// models.json entries are {name,url,group,style,lod,codec,hq}. Older entries without those fields are treated as
// a single sphere model named by the part of the title before " · ".
type LibraryEntry = {
  name: string;
  url: string;
  group?: string;
  style?: StyleName;
  lod?: number;
  codec?: string;
  hq?: boolean;
};
type NormEntry = { name: string; url: string; group: string; style: StyleName; lod: number; codec: string; hq: boolean };

function normalizeEntry(entry: LibraryEntry): NormEntry {
  const base = entry.name.split(' · ')[0];
  const style: StyleName = entry.style ?? (/ribbon/i.test(base) ? 'ribbon' : 'sphere');
  const group =
    entry.group ??
    base
      .replace(/\s*\((sphere|ribbon)\)/i, '')
      .replace(/\s+HQ\b/i, '')
      .trim();
  const codec = entry.codec ?? (/draco/i.test(entry.url) ? 'draco' : 'meshopt');
  return { name: entry.name, url: entry.url, group, style, lod: entry.lod ?? 0, codec, hq: entry.hq ?? /hq/i.test(entry.url) };
}

/** Best file for a style + detail level: prefers the smaller non-HQ Draco build, then meshopt. */
function pickModel(entries: NormEntry[], style: StyleName, lod: number) {
  const matches = entries.filter((entry) => entry.style === style && entry.lod === lod);
  const pool = matches.filter((entry) => !entry.hq);
  const from = pool.length ? pool : matches;
  return from.find((entry) => entry.codec === 'draco') ?? from.find((entry) => entry.codec === 'meshopt') ?? from[0] ?? null;
}

const SLOTS = ['sphere', 'sphereLow', 'ribbon', 'ribbonLow'] as const;
type Slot = (typeof SLOTS)[number];
const SLOT_LABEL: Record<Slot, string> = {
  sphere: 'Sphere model',
  sphereLow: 'Sphere, low detail',
  ribbon: 'Ribbon model',
  ribbonLow: 'Ribbon, low detail',
};
const slotStyle = (slot: Slot): StyleName => (slot.startsWith('ribbon') ? 'ribbon' : 'sphere');
const slotLod = (slot: Slot) => (slot.endsWith('Low') ? 1 : 0);

const emptyOptions = () => ['', '', '', ''];

export function AdminPage() {
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const [codes, setCodes] = useState<AccessCode[]>([]);
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const [label, setLabel] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [expiresAt, setExpiresAt] = useState(tomorrowEvening);
  const [point, setPoint] = useState(UCR);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [radius, setRadius] = useState('30');
  const [spawnExpiry, setSpawnExpiry] = useState('');
  const [rarity, setRarity] = useState<Rarity>('common');
  const [quizQuestion, setQuizQuestion] = useState('');
  const [quizOptions, setQuizOptions] = useState<string[]>(emptyOptions);
  const [quizCorrect, setQuizCorrect] = useState(0);
  const [slotFiles, setSlotFiles] = useState<Partial<Record<Slot, File>>>({});
  const [removeStyles, setRemoveStyles] = useState<StyleName[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [library, setLibrary] = useState<NormEntry[]>([]);
  const [group, setGroup] = useState('');
  const [focusToken, setFocusToken] = useState(0);
  const [spawnSearch, setSpawnSearch] = useState('');
  const [spawnRarity, setSpawnRarity] = useState<'all' | Rarity>('all');
  const [spawnStatus, setSpawnStatus] = useState<'all' | 'active' | 'expired'>('all');
  const [modelTab, setModelTab] = useState<'library' | 'upload'>('library');
  const [settings, setSettings] = useState<AppSettings>({
    leaderboardEnabled: false,
    rarityEnabled: true,
    cloudsEnabled: false,
    cloudDissolveRadius: 120,
    cloudHintRadius: 350,
    cloudTransparency: 15,
  });
  const rarityOn = settings.rarityEnabled;
  const [showHeat, setShowHeat] = useState(false);
  const [showRings, setShowRings] = useState(true);
  const [heat, setHeat] = useState<{ latitude: number; longitude: number; weight: number }[] | null>(null);
  const [scatterOpen, setScatterOpen] = useState(false);
  const [scatterTemplate, setScatterTemplate] = useState('');
  const [scatterCount, setScatterCount] = useState('5');
  const [scatterArea, setScatterArea] = useState('80');
  const [scatterPrefix, setScatterPrefix] = useState('');
  const [scatterCenter, setScatterCenter] = useState(UCR);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}ar/models/models.json`)
      .then((response) => (response.ok ? response.json() : []))
      .then((list: LibraryEntry[]) => setLibrary(list.map(normalizeEntry)))
      .catch(() => setLibrary([]));
  }, []);

  const groups = useMemo(() => {
    const map = new Map<string, NormEntry[]>();
    for (const entry of library) map.set(entry.group, [...(map.get(entry.group) ?? []), entry]);
    return [...map.entries()].map(([groupName, entries]) => ({
      name: groupName,
      entries,
      styles: [...new Set(entries.map((entry) => entry.style))],
      hasLow: entries.some((entry) => entry.lod === 1),
    }));
  }, [library]);
  const activeGroup = groups.find((entry) => entry.name === group) ?? null;

  async function load() {
    const [nextCodes, nextSpawns, nextSettings] = await Promise.all([
      api<AccessCode[]>('/api/admin/codes'),
      api<Spawn[]>('/api/admin/spawns'),
      api<AppSettings>('/api/admin/settings').catch(() => null),
    ]);
    setCodes(nextCodes);
    setSpawns(nextSpawns);
    if (nextSettings) setSettings(nextSettings);
  }

  useEffect(() => {
    load().catch((caught) => toast.error(caught instanceof ApiError ? caught.message : 'Could not load admin data.'));
  }, []);

  useEffect(() => {
    if (!showHeat) {
      setHeat(null);
      return;
    }
    api<{ points: { latitude: number; longitude: number; weight: number }[] }>('/api/admin/heatmap')
      .then((data) => setHeat(data.points))
      .catch((caught) => toast.error(caught instanceof ApiError ? caught.message : 'Could not load the heatmap.'));
  }, [showHeat]);

  async function onCode(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/admin/codes', {
        method: 'POST',
        body: JSON.stringify({
          label,
          code: customCode || undefined,
          expiresAt: new Date(expiresAt).toISOString(),
        }),
      });
      setLabel('');
      setCustomCode('');
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not create the code.');
    }
  }

  async function saveSetting(patch: Partial<typeof settings>) {
    const previous = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings(
        await api<typeof settings>('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
      );
    } catch (caught) {
      setSettings(previous);
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save that setting.');
    }
  }

  function loadQuiz(quiz: Quiz | null | undefined) {
    if (!quiz) {
      setQuizQuestion('');
      setQuizOptions(emptyOptions());
      setQuizCorrect(0);
      return;
    }
    setQuizQuestion(quiz.question);
    setQuizOptions([...quiz.options, '', '', '', ''].slice(0, 4));
    setQuizCorrect(quiz.answerIndex);
  }

  function startEdit(spawn: Spawn) {
    setEditingId(spawn.id);
    setSelectedId(spawn.id);
    setName(spawn.name);
    setSummary(spawn.summary ?? '');
    setPoint({ lat: spawn.latitude, lng: spawn.longitude });
    setRadius(String(spawn.radiusMeters));
    setSpawnExpiry(toLocalInput(spawn.expiresAt));
    setRarity(spawn.rarity ?? 'common');
    loadQuiz(spawn.quiz);
    setSlotFiles({});
    setRemoveStyles([]);
    // Preselect the library model this protein was made from (matched by the file name of its main model).
    const current = spawn.styles[0]?.filename;
    const fromLibrary = library.find((entry) => fileName(entry.url) === current)?.group ?? '';
    setGroup(fromLibrary);
    setModelTab(fromLibrary || !spawn.styles.length ? 'library' : 'upload');
  }

  function startCreate() {
    resetForm();
    setPoint(UCR);
    setCreating(true);
  }

  function resetForm() {
    setEditingId(null);
    setCreating(false);
    setName('');
    setSummary('');
    setRadius('30');
    setSpawnExpiry('');
    setRarity('common');
    loadQuiz(null);
    setSlotFiles({});
    setRemoveStyles([]);
    setGroup('');
    setModelTab('library');
  }

  function quizPayload(): string {
    const question = quizQuestion.trim();
    const filled = quizOptions.map((text, index) => ({ text: text.trim(), index })).filter((option) => option.text);
    if (!question && filled.length === 0) return '';
    if (!question) throw new ApiError('Add the quiz question, or clear the options.', 400);
    if (filled.length < 2) throw new ApiError('A quiz needs at least two answer options.', 400);
    const answerIndex = filled.findIndex((option) => option.index === quizCorrect);
    if (answerIndex < 0) throw new ApiError('Mark one of the filled options as the correct answer.', 400);
    return JSON.stringify({ question, options: filled.map((option) => option.text), answerIndex } satisfies Quiz);
  }

  async function onSpawn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const body = new FormData();
      body.set('name', name);
      body.set('summary', summary);
      body.set('latitude', String(point.lat));
      body.set('longitude', String(point.lng));
      body.set('radiusMeters', radius);
      body.set('expiresAt', spawnExpiry ? new Date(spawnExpiry).toISOString() : '');
      body.set('rarity', rarity);
      body.set('quiz', quizPayload());
      if (removeStyles.length) body.set('removeStyles', removeStyles.join(','));

      const existing = editingId ? spawns.find((item) => item.id === editingId) : null;
      for (const slot of SLOTS) {
        const style = slotStyle(slot);
        if (removeStyles.includes(style)) continue;
        let upload = modelTab === 'upload' ? (slotFiles[slot] ?? null) : null;
        if (!upload && modelTab === 'library' && activeGroup) {
          const picked = pickModel(activeGroup.entries, style, slotLod(slot));
          // Skip re-uploading when the picked library model is already attached to this spawn.
          const attached = existing?.styles.find((entry) => entry.style === style)?.filename;
          const mainPicked = pickModel(activeGroup.entries, style, 0);
          const unchanged = attached && mainPicked && fileName(mainPicked.url) === attached;
          if (picked && !unchanged) {
            const response = await fetch(`${import.meta.env.BASE_URL}ar/${picked.url}`);
            if (!response.ok) throw new ApiError(`Could not load the library model ${picked.name}.`, response.status);
            upload = new File([await response.blob()], fileName(picked.url) || 'model.glb', { type: 'model/gltf-binary' });
          }
        }
        if (upload) body.set(slot, upload);
      }
      if (editingId) await api(`/api/admin/spawns/${editingId}`, { method: 'PATCH', body });
      else await api('/api/admin/spawns', { method: 'POST', body });
      resetForm();
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not place that protein.');
    } finally {
      setBusy(false);
    }
  }

  async function moveSpawn(id: string, lat: number, lng: number) {
    const before = spawns;
    setSpawns((current) => current.map((item) => (item.id === id ? { ...item, latitude: lat, longitude: lng } : item)));
    try {
      await api(`/api/admin/spawns/${id}`, { method: 'PATCH', body: JSON.stringify({ latitude: lat, longitude: lng }) });
      toast.success('Moved.');
      await load();
    } catch (caught) {
      setSpawns(before);
      toast.error(caught instanceof ApiError ? caught.message : 'Could not move that protein.');
    }
  }

  async function onScatter(event: FormEvent) {
    event.preventDefault();
    if (!scatterTemplate) {
      toast.error('Pick a protein to copy.');
      return;
    }
    setBusy(true);
    try {
      const created = await api<Spawn[]>('/api/admin/spawns/scatter', {
        method: 'POST',
        body: JSON.stringify({
          templateId: scatterTemplate,
          count: Number(scatterCount),
          centerLatitude: scatterCenter.lat,
          centerLongitude: scatterCenter.lng,
          areaRadiusMeters: Number(scatterArea),
          namePrefix: scatterPrefix.trim() || undefined,
        }),
      });
      toast.success(`Placed ${created.length} copies.`);
      setScatterOpen(false);
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not scatter copies.');
    } finally {
      setBusy(false);
    }
  }

  const visibleSpawns = useMemo(() => {
    const query = spawnSearch.trim().toLowerCase();
    const now = Date.now();
    return spawns.filter((spawn) => {
      const expired = spawn.expiresAt != null && new Date(spawn.expiresAt).getTime() <= now;
      if (spawnRarity !== 'all' && spawn.rarity !== spawnRarity) return false;
      if (spawnStatus === 'active' && expired) return false;
      if (spawnStatus === 'expired' && !expired) return false;
      if (query && !`${spawn.name} ${spawn.summary ?? ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [spawns, spawnSearch, spawnRarity, spawnStatus]);

  function openScatter() {
    if (!scatterTemplate && spawns.length) setScatterTemplate(spawns[0].id);
    setScatterOpen(true);
  }

  const editing = editingId ? spawns.find((item) => item.id === editingId) : null;

  const spawnEditor = (
    <form onSubmit={onSpawn} className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
      <div className="grid content-start gap-3">
      <div className="h-72 overflow-hidden rounded-lg border">
        {mapboxToken ? (
          <CampusMap
                  rarityColors={rarityOn}
            token={mapboxToken}
            className="h-full w-full"
            user={null}
            spawns={spawns}
            selectedId={selectedId}
            draft={point}
            showCoverage
            onSelect={setSelectedId}
            onPick={setPoint}
          />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground">
            Map key missing. Enter coordinates below.
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">Click the map to drop or move the pin.</p>
        <div className="grid gap-2">
          <Label htmlFor="name">Protein</Label>
          <Input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Hemoglobin" required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="summary">Note</Label>
          <Input id="summary" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="South of the Bell Tower" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="lat">Latitude</Label>
            <Input id="lat" value={point.lat} onChange={(event) => setPoint({ ...point, lat: Number(event.target.value) })} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lng">Longitude</Label>
            <Input id="lng" value={point.lng} onChange={(event) => setPoint({ ...point, lng: Number(event.target.value) })} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="radius">Radius m</Label>
            <Input id="radius" type="number" min={5} max={250} step={1} value={radius} onChange={(event) => setRadius(event.target.value)} required />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
        {rarityOn ? (
          <div className="grid gap-2">
            <Label htmlFor="rarity">Rarity</Label>
            <select
              id="rarity"
              value={rarity}
              onChange={(event) => setRarity(event.target.value as Rarity)}
              className="h-10 rounded-md border bg-card px-3 text-sm"
            >
              {RARITY_ORDER.map((value) => (
                <option key={value} value={value}>
                  {RARITY_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
        ) : null}
          <div className="grid gap-2">
            <Label htmlFor="spawn-expires">Expires, optional</Label>
            <Input id="spawn-expires" type="datetime-local" value={spawnExpiry} onChange={(event) => setSpawnExpiry(event.target.value)} />
          </div>
        </div>
      </div>

      <div className="grid content-start gap-3">
        <fieldset className="grid gap-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Catch quiz, optional</legend>
          <Input
            value={quizQuestion}
            onChange={(event) => setQuizQuestion(event.target.value)}
            placeholder="What does hemoglobin carry?"
            aria-label="Quiz question"
          />
          {quizOptions.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="radio"
                name="quiz-correct"
                checked={quizCorrect === index}
                onChange={() => setQuizCorrect(index)}
                aria-label={`Option ${index + 1} is correct`}
              />
              <Input
                value={option}
                onChange={(event) => setQuizOptions((current) => current.map((text, i) => (i === index ? event.target.value : text)))}
                placeholder={index < 2 ? `Answer ${index + 1}` : `Answer ${index + 1} (optional)`}
                aria-label={`Answer ${index + 1}`}
              />
            </div>
          ))}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Fill 2 to 4 answers and pick the correct one. Empty question = no quiz.</p>
            <Button type="button" size="sm" variant="outline" onClick={() => loadQuiz(null)}>
              Clear quiz
            </Button>
          </div>
        </fieldset>

        <fieldset className="grid gap-3 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">Models</legend>
          <div role="tablist" className="grid grid-cols-2 gap-1 rounded-md bg-secondary p-1 text-sm">
            {([
              ['library', 'Choose from library'],
              ['upload', 'Upload'],
            ] as const).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={modelTab === tab}
                onClick={() => setModelTab(tab)}
                className={cn(
                  'h-8 rounded px-3 font-medium transition-colors',
                  modelTab === tab ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {modelTab === 'library' ? (
            <div className="grid gap-2">
              <Label htmlFor="library">Protein</Label>
              <select
                id="library"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
                className="h-10 rounded-md border bg-card px-3 text-sm"
              >
                <option value="">None</option>
                {groups.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
              </select>
              {activeGroup ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {activeGroup.styles.includes('sphere') ? <Badge variant="muted">Spheres</Badge> : null}
                  {activeGroup.styles.includes('ribbon') ? <Badge variant="muted">Ribbon</Badge> : null}
                  {activeGroup.hasLow ? <Badge variant="muted">Low-detail version</Badge> : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
              {(['sphere', 'ribbon', 'sphereLow', 'ribbonLow'] as const).map((slot) => {
                const style = slotStyle(slot);
                const attached = editing?.styles.find((entry) => entry.style === style);
                const attachedText =
                  slotLod(slot) === 0 ? attached?.filename : attached?.lowUrl ? 'attached' : undefined;
                const note = slotFiles[slot] || !attachedText ? null : `Current: ${attachedText}`;
                return (
                  <div key={slot} className="grid min-w-0 gap-1">
                    <Label htmlFor={`slot-${slot}`}>{SLOT_LABEL[slot]}</Label>
                    <FilePicker
                      id={`slot-${slot}`}
                      accept=".glb,model/gltf-binary"
                      disabled={removeStyles.includes(style)}
                      file={slotFiles[slot] ?? null}
                      onChange={(picked) =>
                        setSlotFiles((current) => {
                          const next = { ...current };
                          if (picked) next[slot] = picked;
                          else delete next[slot];
                          return next;
                        })
                      }
                    />
                    {note ? <p className="truncate text-xs text-muted-foreground" title={note}>{note}</p> : null}
                  </div>
                );
              })}
            </div>
          )}
          {editing && editing.styles.length > 0 ? (
            <div className="flex flex-wrap gap-3 text-sm">
              {editing.styles.map((entry) => (
                <label key={entry.style} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={removeStyles.includes(entry.style)}
                    onChange={(event) =>
                      setRemoveStyles((current) =>
                        event.target.checked ? [...current, entry.style] : current.filter((value) => value !== entry.style),
                      )
                    }
                  />
                  Remove {entry.style} view
                </label>
              ))}
            </div>
          ) : null}
          {editing ? (
            <p className="text-xs text-muted-foreground">
              Editing. Models you leave alone are kept as they are.
            </p>
          ) : null}
        </fieldset>
      </div>
      <div className="flex gap-2 lg:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Place on campus'}
          </Button>
          {editingId ? (
            <Button type="button" variant="outline" onClick={resetForm}>
              Cancel
            </Button>
          ) : null}
        </div>
    </form>
  );

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">Allowlist</p>
          <h1 className="font-display text-4xl">Campus desk</h1>
        </div>
        <Button asChild variant="outline">
          <Link to="/">Back to map</Link>
        </Button>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-3">
            <span>
              <span className="block font-medium">Leaderboard</span>
              <span className="block text-xs text-muted-foreground">
                Players see a ranked list of everyone's XP (first name and last initial).
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="size-5"
              checked={settings.leaderboardEnabled}
              onChange={(event) => void saveSetting({ leaderboardEnabled: event.target.checked })}
              aria-label="Leaderboard on"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-3">
            <span>
              <span className="block font-medium">Rarity levels</span>
              <span className="block text-xs text-muted-foreground">
                Colors and XP by rarity. Off makes every protein plain gray and worth the common reward.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="size-5"
              checked={settings.rarityEnabled}
              onChange={(event) => void saveSetting({ rarityEnabled: event.target.checked })}
              aria-label="Rarity levels on"
            />
          </label>
          <div className="rounded-lg border">
            <label className="flex cursor-pointer items-center justify-between gap-4 px-3 py-3">
              <span>
                <span className="block font-medium">Dynamic cloud cover</span>
                <span className="block text-xs text-muted-foreground">
                  Clouds cover the player's whole map and dissolve around them as they walk. Proteins outside the cleared
                  circle are hidden; a large colored glow in the clouds only hints that one is nearby.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="size-5"
                checked={settings.cloudsEnabled}
                onChange={(event) => void saveSetting({ cloudsEnabled: event.target.checked })}
                aria-label="Dynamic cloud cover on"
              />
            </label>
            {settings.cloudsEnabled ? (
              <div className="grid gap-4 border-t px-3 py-3">
                <RangeSetting
                  id="cloud-dissolve"
                  label="Dissolve radius"
                  unit="m"
                  min={CLOUD_LIMITS.dissolveRadius.min}
                  max={CLOUD_LIMITS.dissolveRadius.max}
                  step={10}
                  value={settings.cloudDissolveRadius}
                  onCommit={(value) => void saveSetting({ cloudDissolveRadius: value })}
                  help="How far around the player the fog is mostly gone. It is clear in the middle and thickens gradually, with no hard edge, out to about twice this. Ground they have walked through stays cleared, and proteins on it show as normal markers."
                />
                <RangeSetting
                  id="cloud-hint"
                  label="Hint radius"
                  unit="m"
                  min={CLOUD_LIMITS.hintRadius.min}
                  max={CLOUD_LIMITS.hintRadius.max}
                  step={25}
                  value={settings.cloudHintRadius}
                  onCommit={(value) => void saveSetting({ cloudHintRadius: value })}
                  help="How big the colored glow is for a hidden protein (its protein color, or the plain color when rarity levels are off). Bigger means less exact. Its center is nudged off the real spot."
                />
                <RangeSetting
                  id="cloud-transparency"
                  label="Cloud transparency"
                  unit="%"
                  min={CLOUD_LIMITS.transparency.min}
                  max={CLOUD_LIMITS.transparency.max}
                  step={5}
                  value={settings.cloudTransparency}
                  onCommit={(value) => void saveSetting({ cloudTransparency: value })}
                  help="Higher lets more of the map show through the clouds."
                />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <section className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Access codes</CardTitle>
            <CardDescription>One code can be redeemed by the whole section. Play ends when it expires or you revoke it.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form onSubmit={onCode} className="grid gap-3">
              <div className="grid gap-2">
                <Label htmlFor="label">Label</Label>
                <Input id="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="BIOL 107, Tuesday" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="expires">Expires</Label>
                  <Input id="expires" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="custom">Code, optional</Label>
                  <Input id="custom" value={customCode} onChange={(event) => setCustomCode(event.target.value.toUpperCase())} placeholder="Generated if blank" />
                </div>
              </div>
              <Button type="submit">Issue code</Button>
            </form>
            <ul className="grid gap-2">
              {codes.map((code) => (
                <li key={code.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div>
                    <p className="font-semibold tracking-wide">{code.code}</p>
                    <p className="text-xs text-muted-foreground">
                      {code.label} · {code.redemptions} redeemed · {code.status === 'active' ? `until ${formatWhen(code.expiresAt)}` : code.status}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={code.status === 'active' ? 'gold' : 'muted'}>{code.status}</Badge>
                    {code.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void api(`/api/admin/codes/${code.id}/revoke`, { method: 'POST' }).then(load);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Protein spawns</CardTitle>
            <CardDescription>
              Players catch inside the radius. Drag a marker to move it. Use Layers on the map for the radius rings and catch heatmap.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="relative h-60 overflow-hidden rounded-lg border">
              {mapboxToken ? (
                <CampusMap
                  rarityColors={rarityOn}
                  token={mapboxToken}
                  className="h-full w-full"
                  user={null}
                  spawns={spawns}
                  selectedId={selectedId}
                  draggableSpawns
                  flyToSelected
                  focusToken={focusToken}
                  showCoverage={showRings}
                  heatmap={showHeat ? heat : null}
                  onMove={(id, lat, lng) => void moveSpawn(id, lat, lng)}
                  onSelect={setSelectedId}
                />
              ) : null}
              <MapLayers
                className="top-2 left-2"
                layers={[
                  { id: 'rings', label: 'Catch radius', hint: 'Ring around each protein', checked: showRings },
                  { id: 'heat', label: 'Catch heatmap', hint: 'Where players caught things', checked: showHeat },
                ]}
                onToggle={(id, checked) => (id === 'heat' ? setShowHeat(checked) : setShowRings(checked))}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={startCreate}>Add protein</Button>
              <Button variant="outline" onClick={openScatter}>
                Scatter copies
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={spawnSearch}
                onChange={(event) => setSpawnSearch(event.target.value)}
                placeholder="Search proteins"
                aria-label="Search proteins"
                className="h-9 min-w-40 flex-1"
              />
              {rarityOn ? (
              <select
                value={spawnRarity}
                onChange={(event) => setSpawnRarity(event.target.value as 'all' | Rarity)}
                aria-label="Filter by rarity"
                className="h-9 rounded-md border bg-card px-2 text-sm"
              >
                <option value="all">All rarities</option>
                {RARITY_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {RARITY_LABEL[value]}
                  </option>
                ))}
              </select>
              ) : null}
              <select
                value={spawnStatus}
                onChange={(event) => setSpawnStatus(event.target.value as 'all' | 'active' | 'expired')}
                aria-label="Filter by status"
                className="h-9 rounded-md border bg-card px-2 text-sm"
              >
                <option value="all">Any status</option>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
              </select>
            </div>
            <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
              {visibleSpawns.length === 0 ? (
                <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {spawns.length === 0 ? 'No proteins yet.' : 'No proteins match.'}
                </li>
              ) : null}
              {visibleSpawns.map((spawn) => (
                <li
                  key={spawn.id}
                  className={cn(
                    'flex items-center justify-between gap-3 px-3 py-2',
                    selectedId === spawn.id && 'bg-accent/60',
                  )}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      setSelectedId(spawn.id);
                      setFocusToken((value) => value + 1);
                    }}
                  >
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{spawn.name}</span>
                      {rarityOn ? <Badge variant="muted">{RARITY_LABEL[spawn.rarity] ?? 'Common'}</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {spawn.catchCount ?? 0} caught · {spawn.radiusMeters} m
                      {spawn.hasQuiz ? ' · quiz' : ''}
                      {spawn.styles.length ? ` · ${spawn.styles.map((entry) => entry.style).join(' + ')}` : ''}
                      {spawn.expiresAt ? ` · until ${formatWhen(spawn.expiresAt)}` : ''}
                    </p>
                  </button>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={() => startEdit(spawn)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (editingId === spawn.id) resetForm();
                        void api(`/api/admin/spawns/${spawn.id}`, { method: 'DELETE' }).then(load);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>
      <ClassDesk spawns={spawns} />
      {editingId || creating ? (
        <div
          className="fixed inset-0 z-50 grid place-items-start justify-items-center overflow-auto bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) resetForm();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') resetForm();
          }}
        >
          <div role="dialog" aria-modal="true" aria-label={editingId ? 'Edit protein' : 'Add protein'} className="w-full max-w-5xl rounded-xl border bg-card p-5 shadow-xl">
            <h2 className="font-display text-2xl">{editingId ? 'Edit protein' : 'Add protein'}</h2>
            <div className="mt-4 grid gap-4">{spawnEditor}</div>
          </div>
        </div>
      ) : null}
      {scatterOpen ? (
        <div
          className="fixed inset-0 z-50 grid place-items-start justify-items-center overflow-auto bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setScatterOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setScatterOpen(false);
          }}
        >
          <div role="dialog" aria-modal="true" aria-label="Scatter copies" className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl">
            <h2 className="font-display text-2xl">Scatter copies</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Place copies of a protein at random spots around a point. Each copy keeps the rarity, quiz and models.
            </p>
            <div className="mt-4 grid gap-4">
              <div className="h-64 overflow-hidden rounded-lg border">
                {mapboxToken ? (
                  <CampusMap
                  rarityColors={rarityOn}
                    token={mapboxToken}
                    className="h-full w-full"
                    user={null}
                    spawns={spawns}
                    selectedId={null}
                    draft={scatterCenter}
                    onSelect={() => undefined}
                    onPick={setScatterCenter}
                  />
                ) : (
                  <div className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground">
                    Map key missing. Enter the center coordinates below.
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Click the map to set the center (white dot).</p>
              <form onSubmit={onScatter} className="grid gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="scatter-template">Copy this protein</Label>
                  <select
                    id="scatter-template"
                    value={scatterTemplate}
                    onChange={(event) => setScatterTemplate(event.target.value)}
                    className="h-10 rounded-md border bg-card px-3 text-sm"
                  >
                    <option value="">Pick one</option>
                    {spawns.map((spawn) => (
                      <option key={spawn.id} value={spawn.id}>
                        {spawn.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="scatter-count">Copies</Label>
                    <Input id="scatter-count" type="number" min={1} max={50} value={scatterCount} onChange={(event) => setScatterCount(event.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="scatter-area">Area radius m</Label>
                    <Input id="scatter-area" type="number" min={20} max={2000} value={scatterArea} onChange={(event) => setScatterArea(event.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="scatter-prefix">Name prefix</Label>
                    <Input id="scatter-prefix" value={scatterPrefix} onChange={(event) => setScatterPrefix(event.target.value)} placeholder="Optional" />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="scatter-lat">Center latitude</Label>
                    <Input id="scatter-lat" value={scatterCenter.lat} onChange={(event) => setScatterCenter({ ...scatterCenter, lat: Number(event.target.value) })} required />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="scatter-lng">Center longitude</Label>
                    <Input id="scatter-lng" value={scatterCenter.lng} onChange={(event) => setScatterCenter({ ...scatterCenter, lng: Number(event.target.value) })} required />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy}>
                    {busy ? 'Placing…' : 'Scatter'}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setScatterOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
