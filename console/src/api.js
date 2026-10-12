import { apiUrl } from './config.js';

export const USER_KEY = 'rsrs.userToken';
export const ADMIN_KEY = 'rsrs.adminToken';
// Read old browser credentials without copying or deleting them. An explicit
// empty current value prevents logout from reviving a legacy credential.
function stored(key) {
  return localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^rsrs\./, 'onememory.')) ?? '';
}

let unauthorized = null;
export function onUnauthorized(handler) {
  unauthorized = handler;
}

export async function api(path, { method = 'GET', body, token, signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(apiUrl(path, import.meta.env?.VITE_API_BASE_URL), { method, headers, body: payload, cache: 'no-store', credentials: 'omit', signal });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (response.status === 401 && unauthorized) unauthorized(path, token);
  if (
    response.status === 403
    && unauthorized
    && String(json.error || '').includes('admin token required')
  ) {
    unauthorized(path, token);
  }
  if (!response.ok) {
    const err = new Error(json.error || response.statusText || 'request failed');
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

export function readToken(key) {
  try {
    return stored(key);
  } catch {
    return '';
  }
}

export function writeToken(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.setItem(key, '');
    return true;
  } catch {
    return false;
  }
}

// Only explicit recovery backup/cleanup may read historical plaintext caches.
// These values never participate in unlocking and no new sensitive value is saved.
const RECOVERY_KEYS = ['rsrs', 'onememory'].flatMap(prefix =>
  ['superPass', 'secretKey', 'superPassAt'].map(name => `${prefix}.${name}`));
export function hasLegacyRecovery() {
  // Storage may be blocked independently. Detection must not break the page;
  // explicit export and deletion still report their storage errors to the user.
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[name];
      if (RECOVERY_KEYS.some(key => storage.getItem(key))) return true;
    } catch { /* This storage is unavailable; inspect the other one. */ }
  }
  return false;
}
export function exportLegacyRecovery() {
  const backup = {};
  for (const [name, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
    for (const key of RECOVERY_KEYS) {
      const value = storage.getItem(key);
      if (value) backup[`${name}:${key}`] = value;
    }
  }
  return JSON.stringify(backup, null, 2);
}
export function clearLegacyRecovery() {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of RECOVERY_KEYS) storage.removeItem(key);
  }
}
// Retired plaintext slots are removed on entry, including signed-out pages.
// Never read or copy their values; keep account sessions and other data intact.
export function removeRetiredSuperPass() {
  let cleared = true;
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[name];
      storage.removeItem('onememory.superPass');
      storage.removeItem('onememory.superPassAt');
    } catch { cleared = false; }
  }
  return cleared;
}
