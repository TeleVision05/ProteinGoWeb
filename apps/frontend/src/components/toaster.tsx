import { createPortal } from 'react-dom';
import { dismissToast, useToasts, type ToastKind } from '@/lib/toast';
import { cn } from '@/lib/utils';

const STYLE: Record<ToastKind, { box: string; bar: string }> = {
  error: { box: 'border-destructive/40 text-destructive', bar: 'bg-destructive' },
  success: { box: 'border-emerald-600/40 text-emerald-800', bar: 'bg-emerald-600' },
  info: { box: 'border-border text-foreground', bar: 'bg-foreground/60' },
};

/** Shows the toasts from lib/toast, top right. Mounted once; sits above the AR overlay (z-60) and the map UI. */
export function Toaster() {
  const toasts = useToasts();
  return createPortal(
    <div
      className="pointer-events-none fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 z-[100] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((item) => (
        <button
          key={item.id}
          type="button"
          role={item.kind === 'error' ? 'alert' : 'status'}
          onClick={() => dismissToast(item.id)}
          className={cn(
            'pointer-events-auto relative overflow-hidden rounded-lg border bg-white text-left text-sm shadow-lg',
            item.leaving ? 'toast-out' : 'toast-in',
            STYLE[item.kind].box,
          )}
        >
          <span className="block px-4 py-3">{item.message}</span>
          <span
            className={cn('toast-bar absolute inset-x-0 bottom-0 h-1 origin-left', STYLE[item.kind].bar)}
            style={{ animationDuration: `${item.duration}ms` }}
          />
        </button>
      ))}
    </div>,
    document.body,
  );
}
