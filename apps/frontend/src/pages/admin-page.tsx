import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CampusMap } from '@/components/campus-map';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import type { AccessCode, Spawn } from '@/lib/types';
import { formatWhen, UCR } from '@/lib/utils';

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

export function AdminPage() {
  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
  const [codes, setCodes] = useState<AccessCode[]>([]);
  const [spawns, setSpawns] = useState<Spawn[]>([]);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [expiresAt, setExpiresAt] = useState(tomorrowEvening);
  const [point, setPoint] = useState(UCR);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [radius, setRadius] = useState('30');
  const [spawnExpiry, setSpawnExpiry] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [library, setLibrary] = useState<{ name: string; url: string }[]>([]);
  const [libraryUrl, setLibraryUrl] = useState('');

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}ar/models/models.json`)
      .then((response) => (response.ok ? response.json() : []))
      .then((list: { name: string; url: string }[]) => setLibrary(list))
      .catch(() => setLibrary([]));
  }, []);

  async function load() {
    const [nextCodes, nextSpawns] = await Promise.all([
      api<AccessCode[]>('/api/admin/codes'),
      api<Spawn[]>('/api/admin/spawns'),
    ]);
    setCodes(nextCodes);
    setSpawns(nextSpawns);
  }

  useEffect(() => {
    load().catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load admin data.'));
  }, []);

  async function onCode(event: FormEvent) {
    event.preventDefault();
    setError('');
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
      setError(caught instanceof ApiError ? caught.message : 'Could not create the code.');
    }
  }

  function startEdit(spawn: Spawn) {
    setEditingId(spawn.id);
    setSelectedId(spawn.id);
    setName(spawn.name);
    setSummary(spawn.summary ?? '');
    setPoint({ lat: spawn.latitude, lng: spawn.longitude });
    setRadius(String(spawn.radiusMeters));
    setSpawnExpiry(toLocalInput(spawn.expiresAt));
    setFile(null);
    // Preselect the library entry this protein was made from (matched by file name).
    setLibraryUrl(library.find((entry) => fileName(entry.url) === spawn.modelFilename)?.url ?? '');
    setError('');
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
    setFile(null);
    setLibraryUrl('');
  }

  async function onSpawn(event: FormEvent) {
    event.preventDefault();
    setError('');
    const body = new FormData();
    body.set('name', name);
    body.set('summary', summary);
    body.set('latitude', String(point.lat));
    body.set('longitude', String(point.lng));
    body.set('radiusMeters', radius);
    body.set('expiresAt', spawnExpiry ? new Date(spawnExpiry).toISOString() : '');
    try {
      let upload = file;
      const currentFile = editingId ? spawns.find((item) => item.id === editingId)?.modelFilename : null;
      // Skip re-uploading when the selected library model is the one already attached.
      if (!upload && libraryUrl && fileName(libraryUrl) !== currentFile) {
        const response = await fetch(`${import.meta.env.BASE_URL}ar/${libraryUrl}`);
        if (!response.ok) throw new ApiError('Could not load that library model.', response.status);
        upload = new File([await response.blob()], libraryUrl.split('/').pop() ?? 'model.glb', {
          type: 'model/gltf-binary',
        });
      }
      if (upload) body.set('file', upload);
      if (editingId) await api(`/api/admin/spawns/${editingId}`, { method: 'PATCH', body });
      else await api('/api/admin/spawns', { method: 'POST', body });
      resetForm();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not place that protein.');
    }
  }

  const spawnEditor = (
    <>
            <div className="h-64 overflow-hidden rounded-lg border">
              {mapboxToken ? (
                <CampusMap
                  token={mapboxToken}
                  className="h-full w-full"
                  user={null}
                  spawns={spawns}
                  selectedId={selectedId}
                  draft={point}
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
            <form onSubmit={onSpawn} className="grid gap-3">
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
              <div className="grid gap-2">
                <Label htmlFor="spawn-expires">Expires, optional</Label>
                <Input id="spawn-expires" type="datetime-local" value={spawnExpiry} onChange={(event) => setSpawnExpiry(event.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="library">Model from library</Label>
                <select
                  id="library"
                  value={libraryUrl}
                  disabled={Boolean(file)}
                  onChange={(event) => setLibraryUrl(event.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  {library.map((entry) => (
                    <option key={entry.url} value={entry.url}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="model">Or upload a GLB</Label>
                <Input id="model" type="file" accept=".glb,model/gltf-binary" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              </div>
              {editingId ? (
                <p className="text-xs text-muted-foreground">
                  Editing. Current model: {spawns.find((item) => item.id === editingId)?.modelFilename ?? 'none'}. Leave the model fields as they are to keep it.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit">{editingId ? 'Save changes' : 'Place on campus'}</Button>
                {editingId ? (
                  <Button type="button" variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
    </>
  );

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">Allowlist</p>
          <h1 className="font-display text-4xl">Campus desk</h1>
        </div>
        <Button asChild variant="outline">
          <Link to="/">Back to map</Link>
        </Button>
      </header>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
            <CardDescription>Players catch inside the radius. No shops or vendor pins.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="h-64 overflow-hidden rounded-lg border">
              {mapboxToken ? (
                <CampusMap
                  token={mapboxToken}
                  className="h-full w-full"
                  user={null}
                  spawns={spawns}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              ) : null}
            </div>
            <Button onClick={startCreate}>Add protein</Button>
            <ul className="grid gap-2">
              {spawns.map((spawn) => (
                <li key={spawn.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <button className="text-left" onClick={() => setSelectedId(spawn.id)}>
                    <p className="font-medium">{spawn.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {spawn.latitude.toFixed(5)}, {spawn.longitude.toFixed(5)} · {spawn.radiusMeters} m
                      {spawn.expiresAt ? ` · until ${formatWhen(spawn.expiresAt)}` : ''}
                    </p>
                  </button>
                  <div className="flex gap-2">
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
      {editingId || creating ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) resetForm();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') resetForm();
          }}
        >
          <div role="dialog" aria-modal="true" aria-label={editingId ? 'Edit protein' : 'Add protein'} className="w-full max-w-lg rounded-xl border bg-card p-5 shadow-xl">
            <h2 className="font-display text-2xl">{editingId ? 'Edit protein' : 'Add protein'}</h2>
            <div className="mt-4 grid gap-4">{spawnEditor}</div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
