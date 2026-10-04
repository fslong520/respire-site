import { pathRestToHash } from './hashRoute.js';

/** The build selects the surface; pathname/hash input never grants an admin surface. */
export function consoleRoute(pathname, target, hash = '') {
  if (!['dashboard', 'admin'].includes(target)) throw new Error('Unknown console build target');
  const path = pathname.replace(/\/+$/, '') || '/';
  const prefix = `/${target}`;
  if (path === '/' || path === prefix) return { supported: true, canonical: null };
  if (path.startsWith(`${prefix}/`)) {
    // Keep an existing hash route, including encoded memory IDs, when canonicalizing.
    return { supported: true, canonical: `${prefix}${hash || pathRestToHash(path.slice(prefix.length + 1))}` };
  }
  return { supported: false, canonical: null };
}
