import { useEffect, useRef } from 'react';
import type { MemoryFishHandle } from './memory-fish';

/*
 * Foreground host for the two memory-fish. The layer is fixed to the viewport,
 * sits above the page content, and never accepts pointer events. The module is
 * lazily imported so the main bundle stays lean; reduced motion, tab visibility
 * and offscreen state all pause or freeze the animation.
 */
export default function MemoryFishLayer() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let handle: MemoryFishHandle | null = null;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = media.matches;
    let visible = true;
    let hidden = document.hidden;

    const sync = () => {
      if (!handle) return;
      handle.setReduced(reduced);
      handle.setPaused(hidden || !visible);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    }, { threshold: 0 });
    observer.observe(host);

    const onVisibility = () => { hidden = document.hidden; sync(); };
    const onPreference = () => { reduced = media.matches; sync(); };
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onPreference);

    void import('./memory-fish')
      .then(({ startMemoryFish }) => {
        if (disposed) return;
        handle = startMemoryFish(host, { reduced });
        sync();
      })
      .catch(() => {});

    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      media.removeEventListener('change', onPreference);
      handle?.dispose();
    };
  }, []);

  return <div ref={hostRef} className="fish-layer" aria-hidden="true" />;
}
