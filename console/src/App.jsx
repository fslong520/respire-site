import { useEffect, useRef, useState } from 'react';
import { forgetTrustedAccount, moveTrustedAccount, rememberTrustedAccount, resolveTrustedAccount } from './trustedBrowser.js';
import { Gate } from './Gate.jsx';
import { clearPendingPasskeyCommit, movePendingPasskeyCommit } from './Passkeys.jsx';
import { Shell } from './Shell.jsx';
import { CliAuthorization } from './CliAuthorization.jsx';
import { GithubCallback } from './GithubCallback.jsx';
import { initialGithubCallback } from './githubAuth.js';
import {
  ADMIN_KEY, USER_KEY, api, onUnauthorized, readToken, writeToken, removeRetiredSuperPass,
} from './api.js';
import { unwrapUrk, deriveDataKeys } from './crypto.js';
import { pathRestToHash } from './hashRoute.js';
import { consoleRoute } from './consoleRoute.js';
import { t } from './i18n.js';
import { readAccounts, saveAccount, removeAccount } from './accounts.js';
import { useI18n } from './ui.jsx';
import { dropUnlockSession, clearUnlockSessions, saveUnlockSession, moveUnlockSession } from './unlockSession.js';

function pagePath() {
  return window.location.pathname.replace(/\/+$/, '') || '/';
}

export default function App() {
  useI18n();
  const path = pagePath();
  const hostname = window.location.hostname;
  const target = hostname === new URL(import.meta.env.VITE_ADMIN_URL).hostname ? 'admin'
    : hostname === new URL(import.meta.env.VITE_DASHBOARD_URL).hostname ? 'dashboard'
    : path === '/admin' || path.startsWith('/admin/') ? 'admin'
    : path === '/dashboard' || path.startsWith('/dashboard/') ? 'dashboard' : null;
  if (target && consoleRoute(path, target, window.location.hash).supported) {
    return <Console admin={target === 'admin'} />;
  }
  return (
    <div className="gate-page" style={{ padding: 48 }}>
      <h1>respire</h1>
      <p>{t('fallbackHint')}</p>
    </div>
  );
}

function Console({ admin }) {
  useI18n();
  const key = admin ? ADMIN_KEY : USER_KEY;
  const [token, setTokenState] = useState(() => readToken(key));
  const [hint, setHint] = useState('');
  const [passkeyOfferToken, setPasskeyOfferToken] = useState('');
  useEffect(() => {
    if (!removeRetiredSuperPass()) setHint(t('legacyRecoveryClearFailed'));
  }, []);
  const [accounts, setAccounts] = useState(() => admin ? [] : readAccounts());
  const [adding, setAdding] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [checked, setChecked] = useState(!readToken(key));
  const entryGeneration = useRef(0);
  const receivingIdentity = useRef(null);
  const [probeRevision, refreshProbe] = useState(0);
  const advanceEntry = (probe = true) => {
    const generation = ++entryGeneration.current;
    if (probe) refreshProbe(revision => revision + 1);
    return generation;
  };
  const [hash, setHash] = useState(window.location.hash);
  const [github, setGithub] = useState(admin ? null : initialGithubCallback);
  const authorization = !admin && (hash === '#/authorize' || hash.startsWith('#/authorize?'));
  const authorizationCode = authorization ? new URLSearchParams(hash.slice('#/authorize?'.length)).get('code') || '' : '';
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const forgetBrowserTrust = (previous, passive = false) => {
    const forgotten = forgetTrustedAccount(previous, undefined, { passive });
    forgotten.completion.then(({ clearedRecords }) => {
      // The count is from the same committed transaction as the logout fence.
      // An empty store still needs that fence, but no trust-removal warning.
      if (forgotten.allAccounts && clearedRecords > 0) setHint(t('trustedLogoutAll'));
    }).catch(() => setHint(t('trustedCleanupFailed')));
  };
  const setToken = (value) => {
    const previous = readToken(key);
    if (!writeToken(key, value)) throw new Error(t('sessionStorageFailed'));
    advanceEntry();
    receivingIdentity.current = null;
    if (!admin && !value && previous) {
      dropUnlockSession(previous);
      clearPendingPasskeyCommit(previous);
      forgetBrowserTrust(previous);
      // Account-list cleanup cannot undo a successful logout.
      try { setAccounts(removeAccount(previous)); }
      catch { setHint(t('accountListFailed')); }
    }
    setTokenState(value);
  };
  async function enterAccount(value, superPass, secretKey, recoveryCreated = false) {
    // The candidate is checked below. Do not re-probe the still-saved old
    // token: its expiry must not cancel a valid replacement account entry.
    const generation = advanceEntry(false);
    const previous = readToken(key);
    const info = await api('/api/self', { token: value });
    if (generation !== entryGeneration.current || readToken(key) !== previous) return false;
    if (!info.user) throw new Error('Account identity missing');
    let vault;
    let dataKey;
    if (superPass) {
      vault = await api('/api/self/vault', { token: value });
      if (generation === entryGeneration.current && readToken(key) === previous) rememberTrustedAccount(value, vault.account_id);
      const urk = await unwrapUrk(superPass, secretKey, vault);
      try { dataKey = await deriveDataKeys(urk, vault.wrapped_urk.startsWith('rsrs:v1:')); }
      finally { urk.fill(0); }
      if (generation !== entryGeneration.current || readToken(key) !== previous) return false;
    }
    setAccounts(saveAccount(info.user, value));
    setToken(value);
    if (dataKey) saveUnlockSession(value, vault, dataKey);
    setAdding(false);
    if (recoveryCreated) setPasskeyOfferToken(value);
    return true;
  }
  async function switchAccount(account) {
    if (switching || account.token === token) return;
    setSwitching(true);
    try {
      if (await enterAccount(account.token)) location.hash = '/memories';
    } catch (error) {
      setHint(error.message);
      if (error.status === 401 || error.status === 403) {
        dropUnlockSession(account.token);
        try { setAccounts(removeAccount(account.token)); }
        catch { setHint(t('accountListFailed')); }
      }
    } finally { setSwitching(false); }
  }
  function addAccount() {
    advanceEntry(false);
    setAdding(true);
  }
  useEffect(() => {
    if (admin) return;
    const changed = (event) => {
      if (event.key === USER_KEY) {
        clearUnlockSessions();
        if (!event.newValue && event.oldValue) {
          clearPendingPasskeyCommit(event.oldValue);
          forgetBrowserTrust(event.oldValue, true);
        }
        advanceEntry();
        const currentToken = readToken(USER_KEY);
        receivingIdentity.current = currentToken ? { token: currentToken, generation: entryGeneration.current } : null;
        setSwitching(false);
        setChecked(false);
        setTokenState(currentToken);
        setAdding(false);
      }
      if (event.key === 'rsrs.dashboard.accounts') setAccounts(readAccounts());
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [admin]);
  useEffect(() => {
    const path = pagePath();
    if (admin && path.startsWith('/admin/')) {
      window.history.replaceState(null, '', `/admin${pathRestToHash(path.slice('/admin/'.length))}`);
    }
    if (!admin && path.startsWith('/dashboard/')) {
      window.history.replaceState(null, '', `/dashboard${pathRestToHash(path.slice('/dashboard/'.length))}`);
    }
  }, [admin]);
  useEffect(() => {
    onUnauthorized((apiPath, requestToken) => {
      if (requestToken !== readToken(key)) return;
      if (admin && apiPath.startsWith('/admin') && !apiPath.startsWith('/admin/login')) setToken('');
      if (!admin && (apiPath.startsWith('/api/self') || apiPath === '/count' || apiPath === '/pull' || apiPath === '/login')) setToken('');
    });
  }, [admin]);
  useEffect(() => {
    if (!token) {
      setChecked(true);
      return;
    }
    const generation = entryGeneration.current, controller = new AbortController();
    const current = () => !controller.signal.aborted && readToken(key) === token && entryGeneration.current === generation;
    const identify = !admin && receivingIdentity.current?.token === token && receivingIdentity.current.generation === generation;
    const probe = admin ? '/admin/me' : '/api/self';
    // Probe auth errors are handled below only while this exact entry is live.
    // The global token-only callback could otherwise sign out a newer ABA entry.
    api(probe, { token, signal: controller.signal, notifyUnauthorized: false })
      .then(async (info) => {
        if (!current()) return;
        if (!admin && info.user) setAccounts(saveAccount(info.user, token));
        if (identify) await resolveTrustedAccount({ token, request: api, signal: controller.signal, isCurrent: current });
        if (!current()) return;
        setChecked(true);
      })
      .catch((err) => {
        if (!current()) return;
        if (err.status === 401 || err.status === 403) setToken('');
        setChecked(true);
      });
    return () => controller.abort();
  }, [admin, token, probeRevision]);
  if (github) {
    const generation = entryGeneration.current;
    return <GithubCallback grant={github} token={token} authorization={authorization}
      onDone={() => { advanceEntry(); setGithub(null); }}
      onEnter={async ({ token: value, superPass, recoveryCreated }) => {
        if (generation !== entryGeneration.current) return;
        if (await enterAccount(value, superPass, undefined, recoveryCreated)) setGithub(null);
      }} />;
  }
  if (!checked) {
    return <div className="gate-page" style={{ padding: 48 }}><p>{t('checkingLogin')}</p></div>;
  }
  if (!token || adding) {
    const gateGeneration = entryGeneration.current;
    return (
      <>
        <Gate
          admin={admin}
          authorization={authorization}
          notify={(t) => { setHint(t); window.setTimeout(() => setHint(''), 3500); }}
          onEnter={({ token: value, superPass, secretKey, recoveryCreated }) => {
            if (gateGeneration !== entryGeneration.current) return false;
            return admin ? setToken(value) : enterAccount(value, superPass, secretKey, recoveryCreated);
          }}
        />
        {adding && <button type="button" className="gate-link" onClick={() => { advanceEntry(); setAdding(false); }}>{t('cancel')}</button>}
        <div className={`toast ${hint ? 'visible' : ''}`} role="status">{hint}</div>
      </>
    );
  }
  if (authorization) return <CliAuthorization key={`${token}:${authorizationCode}`} token={token} code={authorizationCode} onLogout={() => setToken('')} />;
  return (
    <>
    <Shell
      key={token}
      admin={admin}
      token={token}
      accounts={accounts}
      passkeyOffer={passkeyOfferToken === token}
      onDismissPasskeyOffer={() => setPasskeyOfferToken('')}
      switching={switching}
      onSwitchAccount={switchAccount}
      onAddAccount={addAccount}
      onToken={(value) => {
        if (!admin) {
          const current = accounts.find(account => account.token === token);
          if (current) setAccounts(saveAccount(current.user, value));
        }
        setToken(value);
        if (!admin) {
          moveUnlockSession(token, value);
          // This callback is used only by authenticated same-account rotation.
          // setToken must succeed before public pending metadata can move.
          movePendingPasskeyCommit(token, value);
          moveTrustedAccount(token, value, readToken(USER_KEY));
        }
      }}
      onLogout={() => { try { setToken(''); } catch (error) { setHint(error.message); } }}
    />
    <div className={`toast ${hint ? 'visible' : ''}`} role="status">{hint}</div>
    </>
  );
}
