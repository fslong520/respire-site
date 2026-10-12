import { api } from './api.js';

const STORAGE = 'respire.githubAuthorization';

export async function beginGithub(token) {
  const base = token ? '/api/self/github' : '/oauth/github';
  const reply = await api(`${base}/start`, { method: 'POST', token });
  // A separate browser correlation prevents login CSRF; no token or vault key is stored here.
  sessionStorage.setItem(STORAGE, JSON.stringify({ state: reply.state, bind: !!token,
    hash: window.location.hash, expires: Date.now() + reply.expires_in * 1000 }));
  window.location.assign(reply.authorization_uri);
}

export function githubCallback(location = window.location, storage = sessionStorage) {
  const query = new URLSearchParams(location.search);
  if (!query.has('state') || (!query.has('code') && !query.has('error'))) return null;
  let pending;
  try { pending = JSON.parse(storage.getItem(STORAGE)); } catch { /* invalid local grant */ }
  storage.removeItem(STORAGE);
  if (!pending || pending.state !== query.get('state') || !Number.isFinite(pending.expires) || pending.expires <= Date.now()) {
    return { error: 'GitHub authorization does not match this browser. Please start again.' };
  }
  if (query.has('error')) return { error: 'GitHub authorization was cancelled.', hash: pending.hash };
  return { state: pending.state, code: query.get('code'), bind: pending.bind, hash: pending.hash };
}

// Consume once before rendering: React StrictMode must not consume the callback twice.
export const initialGithubCallback = typeof window === 'undefined' ? null : githubCallback();
if (initialGithubCallback) {
  window.history.replaceState(null, '', window.location.pathname + (initialGithubCallback.hash || ''));
}
