export const DEFAULT_API_BASE_URL = 'https://api.rsrs.rs';

/** Public API origin only. Never put credentials, tokens, or recovery material here. */
export function normalizeApiBase(value = DEFAULT_API_BASE_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('VITE_API_BASE_URL must be an absolute API origin'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('VITE_API_BASE_URL must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

export function apiUrl(path, base = DEFAULT_API_BASE_URL) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('API path must be a logical absolute path, not an external URL');
  }
  return `${normalizeApiBase(base)}${path}`;
}
