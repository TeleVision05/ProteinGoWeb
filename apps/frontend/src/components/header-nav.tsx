import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export type NavItem = { to: string; label: string };

/** Room kept for the wordmark on the left of the header before the links are folded into a menu. */
const MIN_LEFT = 112;

/**
 * The header's right side: the links sit side by side while they fit, and fold into one "Menu" dropdown when the
 * header is too narrow. Sign out stays outside the menu. It must be a direct child of a flex header whose first
 * child is the title block, because it measures the room that title leaves.
 */
export function HeaderNav({ items, onSignOut }: { items: NavItem[]; onSignOut: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const location = useLocation();

  // An invisible copy of the full inline row is measured, so the decision does not flip back and forth.
  useLayoutEffect(() => {
    const header = wrap.current?.parentElement;
    const full = measure.current;
    if (!header || !full) return;
    const update = () => {
      const style = getComputedStyle(header);
      const inner = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const gap = parseFloat(style.columnGap) || 12;
      setCollapsed(full.scrollWidth + MIN_LEFT + gap > inner);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(full);
    return () => observer.disconnect();
  }, [items.length]);

  useEffect(() => setOpen(false), [location.pathname, collapsed]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
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

  const signOut = (
    <Button
      size="sm"
      variant="ghost"
      className="text-primary-foreground hover:bg-white/10"
      onClick={onSignOut}
    >
      Sign out
    </Button>
  );

  return (
    <div ref={wrap} className="relative flex shrink-0 items-center gap-1.5">
      {/* Hidden full-width copy used only for measuring. */}
      <div
        ref={measure}
        aria-hidden="true"
        className="pointer-events-none invisible absolute right-0 flex items-center gap-1.5 whitespace-nowrap"
      >
        {items.map((item) => (
          <Button key={item.to} size="sm" variant="secondary" tabIndex={-1}>
            {item.label}
          </Button>
        ))}
        {signOut}
      </div>

      {collapsed ? (
        items.length ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              Menu
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </Button>
            {open ? (
              <div
                role="menu"
                className="absolute top-full right-0 z-50 mt-2 w-48 overflow-hidden rounded-lg border bg-card p-1 text-card-foreground shadow-lg"
              >
                {items.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    role="menuitem"
                    className="block rounded-md px-3 py-2 text-sm font-medium hover:bg-accent"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </>
        ) : null
      ) : (
        items.map((item) => (
          <Button key={item.to} asChild size="sm" variant="secondary">
            <Link to={item.to}>{item.label}</Link>
          </Button>
        ))
      )}
      {signOut}
    </div>
  );
}
