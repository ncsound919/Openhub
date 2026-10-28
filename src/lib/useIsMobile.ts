import { useEffect, useState } from 'react';

function matchesMobile(breakpoint: number): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
}

/**
 * Returns true when the viewport is below the `md` breakpoint (768px).
 * Used by mobile-specific UI decisions (e.g. hiding Monaco, showing drawers).
 *
 * The first value is read synchronously on the client: defaulting to `false`
 * meant a phone painted (and downloaded) the desktop dashboard for a frame
 * before the redirect to Mission Control, on every app launch.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(() => matchesMobile(breakpoint));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Safari < 14 fallback
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [breakpoint]);
  return isMobile;
}

export default useIsMobile;
