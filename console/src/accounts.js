import { USER_KEY, readToken } from './api.js';

const KEY = 'rsrs.dashboard.accounts';

// Keep sign-in sessions, never passwords or memory decryption keys.
export function readAccounts() {
  // This optional session list must not prevent access to the active account.
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => row && typeof row.user === 'string' && row.user
      && typeof row.token === 'string' && row.token)
      .map(({ user, token }) => ({ user, token }));
  } catch {
    return [];
  }
}

export function saveAccount(user, token) {
  const rows = readAccounts().filter(row => row.user !== user && row.token !== token);
  rows.push({ user, token });
  localStorage.setItem(KEY, JSON.stringify(rows));
  return rows;
}

export function removeAccount(token) {
  const rows = readAccounts().filter(row => row.token !== token);
  localStorage.setItem(KEY, JSON.stringify(rows));
  return rows;
}

export function currentAccount() {
  return readAccounts().find(row => row.token === readToken(USER_KEY));
}
