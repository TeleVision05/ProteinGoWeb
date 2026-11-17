import { useEffect, useRef, useState } from 'react';

export type MapLayer = { id: string; label: string; hint?: string; checked: boolean };

/** A "Layers" button that sits on a map and opens a small menu of overlays to switch on and off, like Google Maps. */
export function MapLayers({
  layers,
  onToggle,
  className = '',
}: {
  layers: MapLayer[];
  onToggle: (id: string, checked: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const active = layers.filter((layer) => layer.checked).length;

  return (
    <div ref={root} className={`absolute z-10 ${className}`}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium shadow-md hover:bg-accent"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 13 9 5 9-5" />
        </svg>
        Layers
        {active ? <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{active}</span> : null}
      </button>
      {open ? (
        <div role="menu" className="mt-1 w-56 rounded-lg border bg-card p-2 shadow-lg">
          <p className="px-2 pt-1 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Map details</p>
          {layers.map((layer) => (
            <label key={layer.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={layer.checked}
                onChange={(event) => onToggle(layer.id, event.target.checked)}
              />
              <span>
                {layer.label}
                {layer.hint ? <span className="block text-xs text-muted-foreground">{layer.hint}</span> : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
