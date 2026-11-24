import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { toast } from '@/lib/toast';
import type { AdminAssignment, Roster, Spawn } from '@/lib/types';
import { formatWhen } from '@/lib/utils';

const selectClass = 'h-10 rounded-md border bg-card px-3 text-sm';

function errorText(caught: unknown, fallback: string) {
  return caught instanceof ApiError ? caught.message : fallback;
}

/** The teacher's side of an assignment: set one up, then see who has finished and which questions were hard. */
export function ClassDesk({ spawns }: { spawns: Spawn[] }) {
  const [assignments, setAssignments] = useState<AdminAssignment[]>([]);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const [viewing, setViewing] = useState(''); // assignment id, or '' for everyone
  const [roster, setRoster] = useState<Roster | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);

  const choices = useMemo(
    () => [...spawns].sort((a, b) => a.name.localeCompare(b.name)),
    [spawns],
  );

  const loadAssignments = useCallback(async () => {
    try {
      setAssignments(await api<AdminAssignment[]>('/api/admin/assignments'));
    } catch (caught) {
      toast.error(errorText(caught, 'Could not load the assignments.'));
    }
  }, []);

  const loadRoster = useCallback(async (assignmentId: string) => {
    setLoadingRoster(true);
    try {
      const query = assignmentId ? `?assignmentId=${encodeURIComponent(assignmentId)}` : '';
      setRoster(await api<Roster>(`/api/admin/roster${query}`));
    } catch (caught) {
      toast.error(errorText(caught, 'Could not load the roster.'));
    } finally {
      setLoadingRoster(false);
    }
  }, []);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  useEffect(() => {
    void loadRoster(viewing);
  }, [viewing, loadRoster]);

  // An assignment that was deleted can't stay selected.
  useEffect(() => {
    if (viewing && !assignments.some((item) => item.id === viewing)) setViewing('');
  }, [assignments, viewing]);

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const created = await api<AdminAssignment>('/api/admin/assignments', {
        method: 'POST',
        body: JSON.stringify({
          title,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          spawnIds: [...picked],
        }),
      });
      toast.success(`Assignment "${created.title}" created.`);
      setTitle('');
      setDueAt('');
      setPicked(new Set());
      await loadAssignments();
      setViewing(created.id);
    } catch (caught) {
      toast.error(errorText(caught, 'Could not create the assignment.'));
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(item: AdminAssignment) {
    try {
      await api(`/api/admin/assignments/${item.id}`, { method: 'DELETE' });
      toast.success(`Removed "${item.title}". Students' catches are not affected.`);
      await loadAssignments();
    } catch (caught) {
      toast.error(errorText(caught, 'Could not remove the assignment.'));
    }
  }

  async function downloadCsv() {
    try {
      const query = viewing ? `?assignmentId=${encodeURIComponent(viewing)}` : '';
      const response = await fetch(`${API_URL}/api/admin/roster.csv${query}`, { credentials: 'include' });
      if (!response.ok) throw new ApiError(response.statusText || 'Could not export the roster.', response.status);
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'proteingo-roster.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } catch (caught) {
      toast.error(errorText(caught, 'Could not export the roster.'));
    }
  }

  const showing = roster?.assignment ?? null;

  return (
    <section className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Assignments</CardTitle>
          <CardDescription>
            Pick the proteins students must catch. Each student who catches them all gets their own completion code to
            hand in. The due date only marks a finish as late; it never stops anyone from playing.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <form onSubmit={onCreate} className="grid content-start gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="assignment-title">Title</Label>
                <Input id="assignment-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Lab 3: Muscle proteins" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="assignment-due">Due, optional</Label>
                <Input id="assignment-due" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
              </div>
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Required proteins ({picked.size} picked)</Label>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set(choices.map((item) => item.id)))}>
                    All
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                    None
                  </Button>
                </div>
              </div>
              <ul className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border p-2">
                {choices.length === 0 ? <li className="px-1 text-sm text-muted-foreground">Add some proteins first.</li> : null}
                {choices.map((item) => (
                  <li key={item.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-secondary/60">
                      <input type="checkbox" checked={picked.has(item.id)} onChange={() => toggle(item.id)} />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {item.hasQuiz ? <span className="text-xs text-muted-foreground">quiz</span> : null}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create assignment'}
            </Button>
          </form>
          <ul className="grid content-start gap-2">
            {assignments.length === 0 ? <li className="text-sm text-muted-foreground">No assignments yet.</li> : null}
            {assignments.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.spawns.length} protein{item.spawns.length === 1 ? '' : 's'}
                    {item.dueAt ? ` · due ${formatWhen(item.dueAt)}` : ' · no due date'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={() => setViewing(item.id)}>
                    Roster
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void onRemove(item)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Roster</CardTitle>
          <CardDescription>
            Everyone who joined with a class code or caught a protein. The completion code matches what the student
            hands in, so you can check it here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2">
              <Label htmlFor="roster-assignment">Show progress for</Label>
              <select id="roster-assignment" className={selectClass} value={viewing} onChange={(event) => setViewing(event.target.value)}>
                <option value="">All students, no assignment</option>
                {assignments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="outline" onClick={() => void loadRoster(viewing)} disabled={loadingRoster}>
              {loadingRoster ? 'Loading…' : 'Refresh'}
            </Button>
            <Button onClick={() => void downloadCsv()}>Download CSV</Button>
          </div>

          {roster && roster.students.length === 0 ? <p className="text-sm text-muted-foreground">No students yet.</p> : null}
          {roster && roster.students.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-secondary/60 text-xs text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-2">Student</th>
                    <th className="px-3 py-2">Section</th>
                    <th className="px-3 py-2 text-right">Caught</th>
                    <th className="px-3 py-2 text-right">First try</th>
                    <th className="px-3 py-2 text-right">Wrong</th>
                    {showing ? <th className="px-3 py-2">{showing.title}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {roster.students.map((student) => (
                    <tr key={student.userId} className="border-t">
                      <td className="px-3 py-2">
                        <p className="font-medium">{student.name}</p>
                        <p className="text-xs text-muted-foreground">{student.email}</p>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{student.sections.join(', ') || 'None'}</td>
                      <td className="px-3 py-2 text-right">{student.caught}</td>
                      <td className="px-3 py-2 text-right">{student.firstTry}</td>
                      <td className="px-3 py-2 text-right">{student.wrongAnswers}</td>
                      {showing ? (
                        <td className="px-3 py-2">
                          {student.assignment?.done ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="gold">Done</Badge>
                              {student.assignment.late ? <Badge variant="muted">Late</Badge> : null}
                              <span className="font-mono text-xs tracking-wider">{student.assignment.code}</span>
                              <span className="text-xs text-muted-foreground">
                                {student.assignment.completedAt ? formatWhen(student.assignment.completedAt) : ''}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              {student.assignment?.caught ?? 0}/{student.assignment?.total ?? 0}
                            </span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {roster && roster.questions.length > 0 ? (
            <div className="grid gap-2">
              <h3 className="font-display text-lg">Which questions were hard</h3>
              <p className="text-sm text-muted-foreground">Most wrong answers first: worth going over in lab.</p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-secondary/60 text-xs text-muted-foreground uppercase">
                    <tr>
                      <th className="px-3 py-2">Question</th>
                      <th className="px-3 py-2 text-right">Caught</th>
                      <th className="px-3 py-2 text-right">Right first try</th>
                      <th className="px-3 py-2 text-right">Wrong answers</th>
                      <th className="px-3 py-2">Most common wrong answer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.questions.map((question) => (
                      <tr key={question.spawnId} className="border-t">
                        <td className="px-3 py-2">
                          <p className="font-medium">{question.question}</p>
                          <p className="text-xs text-muted-foreground">{question.name}</p>
                        </td>
                        <td className="px-3 py-2 text-right">{question.caught}</td>
                        <td className="px-3 py-2 text-right">
                          {question.firstTryPercent == null ? 'None yet' : `${question.firstTryPercent}%`}
                        </td>
                        <td className="px-3 py-2 text-right">{question.wrongAnswers}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {question.topWrong ? `${question.topWrong.answer} (${question.topWrong.count})` : 'None'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
