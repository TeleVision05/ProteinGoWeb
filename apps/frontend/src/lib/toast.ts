import { useSyncExternalStore } from 'react';

export type ToastKind = 'error' | 'success' | 'info';
export type ToastItem = { id: number; kind: ToastKind; message: string; duration: number; leaving: boolean };

const DURATION: Record<ToastKind, number> = { error: 6000, success: 3500, info: 4000 };
const MAX_VISIBLE = 4;
const LEAVE_MS = 250; // matches the slide-out in index.css

let items: ToastItem[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function remove(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  items = items.filter((item) => item.id !== id);
  emit();
}

/** Slides the toast out, then removes it. */
export function dismissToast(id: number) {
  const item = items.find((entry) => entry.id === id);
  if (!item || item.leaving) return;
  clearTimeout(timers.get(id));
  items = items.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry));
  timers.set(id, setTimeout(() => remove(id), LEAVE_MS));
  emit();
}

function show(kind: ToastKind, message: string) {
  const text = message.trim();
  if (!text) return;
  // The same message again (a retried tap, a double failure) restarts the existing toast instead of stacking.
  const existing = items.find((item) => item.kind === kind && item.message === text);
  if (existing) remove(existing.id);
  const id = nextId++;
  items = [...items, { id, kind, message: text, duration: DURATION[kind], leaving: false }].slice(-MAX_VISIBLE);
  timers.set(id, setTimeout(() => dismissToast(id), DURATION[kind]));
  emit();
}

export const toast = {
  error: (message: string) => show('error', message),
  success: (message: string) => show('success', message),
  info: (message: string) => show('info', message),
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useToasts() {
  return useSyncExternalStore(subscribe, () => items);
}
