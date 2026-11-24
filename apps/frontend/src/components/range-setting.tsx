import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';

/** A labelled slider that saves once, when the admin lets go, instead of on every step of the drag. */
export function RangeSetting({
  id,
  label,
  help,
  unit,
  min,
  max,
  step,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  help: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-sm text-muted-foreground tabular-nums">
          {draft} {unit}
        </span>
      </div>
      <input
        id={id}
        type="range"
        className="w-full accent-primary"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}
