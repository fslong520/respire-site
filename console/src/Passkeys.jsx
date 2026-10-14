import { useEffect, useRef, useState } from 'react';
import { Key, Plus, Trash, X } from '@phosphor-icons/react';
import { api, readToken, USER_KEY } from './api.js';
import { bindPasskey, unlockWithPasskey, passkeyAvailable, validatePasskeyOrigin, assertPasskeyCurrent, passkeyCommitConfirmed, reconcilePasskeyCommit, movePasskeyCommit } from './passkeys.js';
import { bindTrustedBrowser, unlockWithTrustedBrowser, rememberTrustedAccount } from './trustedBrowser.js';
import { trustedKeyStore } from './trustedKeyStore.js';
import { Button, Note, useI18n } from './ui.jsx';
import { t } from './i18n.js';

// Public binding metadata only, retained across navigation within this page.
// An early empty list must not erase an uncertain in-flight commit.
const pendingCommits = new Map();
export const clearPendingPasskeyCommit = token => pendingCommits.delete(token);
export const movePendingPasskeyCommit = (from, to) => movePasskeyCommit(pendingCommits, from, to, readToken(USER_KEY));

function errorText(error) {
  if (error.name === 'NotAllowedError' || error.name === 'AbortError') return t('passkeyCancelled');
  if (error.name === 'OperationError') return t('passkeyDecryptFailed');
  if (error.code) return t(error.code);
  if (error.name === 'NotSupportedError' || error.name === 'SecurityError') return t('passkeyUnavailable');
  return error.message;
}

// URKs, KEKs, and PRF values never enter React state. The typed recovery
// value lives only in the open input/form and is cleared after each attempt.
export function Passkeys({ token, mode = 'unlock', hasVault = true, unlocked = false, open, notify, beginUnlock, onUnlock, onCancelUnlock }) {
  useI18n();
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [selected, setSelected] = useState('');
  const [localTrusted, setLocalTrusted] = useState([]);
  const [commitNotice, setCommitNotice] = useState(() => pendingCommits.has(token) ? 'passkeyCommitUnknown' : '');
  const listGeneration = useRef(0);
  const resolvedCommit = useRef(null);
  const active = useRef(null);
  const mounted = useRef(true);
  const request = (path, options = {}) => api(`/api/self/passkeys${path}`, { ...options, token });
  const load = async (signal) => {
    const generation = ++listGeneration.current;
    const observed = pendingCommits.get(token);
    let observedKeys;
    try { observedKeys = await trustedKeyStore.listAll({ signal }); } catch { /* PRF still works without local trust. */ }
    const next = await request('', { signal });
    if (generation !== listGeneration.current || signal?.aborted || readToken(USER_KEY) !== token) return;
    const outcome = reconcilePasskeyCommit(pendingCommits, token, observed, next);
    if (outcome === 'stale') return;
    rememberTrustedAccount(token, next.account_id);
    let localKeys = [];
    if (next.trusted_browser_enabled) {
      const localGuard = { signal, isCurrent: () => readToken(USER_KEY) === token && generation === listGeneration.current };
      try {
        await trustedKeyStore.reconcile(next, next.credentials.filter(c => c.mode === 'trusted_browser').map(c => ({ ...next, ...c })),
          { ...localGuard, observedRecords: observedKeys?.filter(key => key.account_id === next.account_id && key.rp_id === next.rp_id) });
        // A positive server listing can resolve an interrupted commit without
        // creating a local key or deleting keys whose outcome is still unknown.
        for (const credential of next.credentials.filter(c => c.mode === 'trusted_browser')) {
          const metadata = { ...next, ...credential };
          if (await trustedKeyStore.read(metadata, localGuard)) await trustedKeyStore.markActive(metadata, credential.credential_id, localGuard);
        }
        localKeys = await trustedKeyStore.list(next, localGuard);
      } catch (error) {
        if (mounted.current && !signal?.aborted && readToken(USER_KEY) === token) setError(errorText(error));
      }
    }
    if (generation !== listGeneration.current || signal?.aborted || readToken(USER_KEY) !== token) return;
    let notice;
    if (outcome === 'confirmed') {
      resolvedCommit.current = observed;
      notice = 'passkeyCommitFound';
    } else if (outcome === 'changed') {
      // Reset/account changes invalidate the old transaction's local fence.
      // They do not prove whether a binding existed before that change.
      notice = 'passkeyCommitChanged';
    } else if (outcome === 'unknown') notice = 'passkeyCommitUnknown';
    else if (resolvedCommit.current && !passkeyCommitConfirmed(resolvedCommit.current, next)) {
      resolvedCommit.current = null;
      notice = '';
    }
    // Even after navigation, the token-fenced read can safely reconcile public
    // metadata. It never mutates an unmounted component or reopens its modal.
    if (!mounted.current) return next;
    if (notice !== undefined) setCommitNotice(notice);
    setConfig(next);
    setLocalTrusted(localKeys);
    setSelected(value => next.credentials?.some(c => c.credential_id === value) ? value : next.credentials?.[0]?.credential_id || '');
    return next;
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    load(controller.signal).catch(error => {
      if (error.name !== 'AbortError' && mounted.current) setError(errorText(error));
    });
    return () => { mounted.current = false; controller.abort(); active.current?.abort(); active.current = null; };
  }, [token]);
  const refreshUnknown = operation => {
    if (!operation.commitDispatched || operation.commitConfirmed || readToken(USER_KEY) !== token) return;
    // A newer operation/list result owns the UI. Never restore an old record or
    // show results for a switched account, or reopen a dismissed dialog.
    if (pendingCommits.get(token) !== operation.commitRecord) return;
    if (mounted.current) setCommitNotice('passkeyCommitUnknown');
    // A fresh independent GET survives cancellation and navigation. Its own
    // token fence prevents reading/updating a newly selected account's state.
    if (!operation.refreshPromise) operation.refreshPromise = load()
      .catch(() => { /* Keep uncertainty; manual refresh remains available. */ })
      .finally(() => { operation.refreshPromise = null; });
    if (!operation.unknownNotified) { operation.unknownNotified = true; notify(t('passkeyCommitUnknown')); }
  };
  const begin = () => {
    active.current?.abort();
    const controller = new AbortController();
    const route = globalThis.location?.hash;
    active.current = controller;
    // Hash navigation precedes React's keyed-child cleanup. Fence that gap so
    // a late native result cannot verify/unlock the route the user just left.
    const isCurrent = () => mounted.current && active.current === controller && readToken(USER_KEY) === token
      && globalThis.location?.hash === route;
    return { controller, signal: controller.signal, isCurrent, current: () => assertPasskeyCurrent(controller.signal, isCurrent) };
  };
  const finish = operation => {
    if (active.current !== operation.controller) return;
    active.current = null;
    if (mounted.current) { setBusy(false); setStage(''); }
  };
  const cancel = () => {
    const wasUnlock = active.current?.unlocking;
    active.current?.abort(); active.current = null;
    if (wasUnlock) onCancelUnlock?.();
    setBusy(false); setStage(''); setError(t('passkeyCancelled'));
  };
  const available = passkeyAvailable();
  const canTry = available && config?.enabled;
  async function unlock() {
    if (busy || unlocked) return;
    const operation = begin();
    operation.controller.unlocking = true;
    const lease = beginUnlock();
    const isCurrent = () => operation.isCurrent() && lease.isCurrent();
    let dataKey, assertTrustedCurrent, delivered = false;
    setBusy(true); setError(''); setStage('passkeyVerifying');
    try {
      const next = await load(operation.signal);
      operation.current(); validatePasskeyOrigin(next);
      const vault = await api('/api/self/vault', { token, signal: operation.signal });
      assertPasskeyCurrent(operation.signal, isCurrent);
      const credential = next.credentials.find(c => c.credential_id === selected);
      const unlockMethod = credential?.mode === 'trusted_browser' ? unlockWithTrustedBrowser : unlockWithPasskey;
      dataKey = await unlockMethod({ request, vault, config: next, credentialId: selected, deviceId: credential?.device_id,
        signal: operation.signal, isCurrent, onKeyLease: lease => { assertTrustedCurrent = lease.assertCurrent; } });
      assertPasskeyCurrent(operation.signal, isCurrent);
      await onUnlock(dataKey, vault, { generation: lease.generation, isCurrent, signal: operation.signal, assertTrustedCurrent, onAccept: () => { delivered = true; } });
      delivered = true;
    } catch (error) {
      if (operation.isCurrent()) setError(errorText(error));
    } finally {
      // onUnlock owns derived keys only after accepting them into the session.
      if (!delivered) { dataKey?.legacy.fill(0); dataKey?.current.fill(0); }
      finish(operation);
    }
  }
  async function openBinding() {
    if (busy || pendingCommits.has(token) || !mounted.current || readToken(USER_KEY) !== token) return;
    const operation = begin();
    setBusy(true); setError('');
    try {
      const next = await load(operation.signal);
      operation.current(); validatePasskeyOrigin(next);
      const vault = await api('/api/self/vault', { token, signal: operation.signal });
      operation.current();
      open({
        title: t('passkeyBind'), description: `${t('passkeyBindDescription')}${next.trusted_browser_enabled ? ` ${t('trustedBrowserConsent')}` : ''}`,
        fields: [
          ...(next.trusted_browser_enabled ? [{ name: 'unlockMode', label: t('trustedBrowserMode'), value: 'prf',
            options: [['prf', t('trustedBrowserPrfChoice')], ['trusted_browser', t('trustedBrowserChoice')]], hint: t('trustedBrowserConsent') }] : []),
          { name: 'label', label: t('passkeyLabel'), value: '', required: false },
          { name: 'superPass', label: Number(vault.version) >= 4 ? t('labelSuperA3') : t('labelSuperPass'), type: 'password' },
          ...(Number(vault.version) === 3 ? [{ name: 'secretKey', label: 'Secret Key', type: 'password' }] : []),
        ],
        submit: t('passkeyBind'),
        onDismiss: () => { refreshUnknown(operation); operation.controller.abort(); finish(operation); },
        onSubmit: async values => {
          operation.current();
          if (operation.commitDispatched) throw new Error(t('passkeyCommitUnknown'));
          try {
            const bindMethod = values.unlockMode === 'trusted_browser' ? bindTrustedBrowser : bindPasskey;
            await bindMethod({ request, vault, config: next, label: values.label.trim().slice(0, 80) || t('passkeyUnnamed'),
              superPass: values.superPass, secretKey: values.secretKey, signal: operation.signal,
              isCurrent: operation.isCurrent, onStage: (value, metadata) => {
                operation.current();
                if (value === 'passkeyCommitting') {
                  operation.commitDispatched = true; operation.commitRecord = metadata;
                  pendingCommits.set(token, metadata);
                }
                setStage(value);
              } });
            operation.current();
            operation.commitConfirmed = true;
            if (pendingCommits.get(token) === operation.commitRecord) pendingCommits.delete(token);
            setCommitNotice('');
            notify(t('passkeyBound'));
            await load(operation.signal);
            operation.current();
          } catch (error) {
            if (error.code === 'passkeyCommitUnknown') {
              refreshUnknown(operation);
              // Close the stale form; the authoritative list and persistent
              // outcome notice now own recovery, without resubmitting a commit.
              return true;
            }
            throw new Error(errorText(error));
          } finally { values.superPass = ''; values.secretKey = ''; if (operation.isCurrent()) setStage(''); }
        },
      });
    } catch (error) {
      if (operation.isCurrent()) setError(errorText(error));
      finish(operation);
    }
  }
  function retryUnknown() {
    const pending = pendingCommits.get(token);
    if (!pending) return;
    const controller = new AbortController();
    const route = globalThis.location?.hash;
    let cancelled = false, continued = false;
    const current = () => !cancelled && !controller.signal.aborted && mounted.current && readToken(USER_KEY) === token
      && globalThis.location?.hash === route;
    open({ title: t('passkeyRetryUnknown'), description: t('passkeyRetryWarning'), submit: t('passkeyRetryConfirm'),
      onDismiss: () => { if (!continued) { cancelled = true; controller.abort(); } },
      onSubmit: async () => {
        const next = await load(controller.signal);
        if (!current()) throw new DOMException('Retry cancelled or account changed', 'AbortError');
        if (!next) throw new Error(t('passkeyChanged'));
        if (passkeyCommitConfirmed(pending, next)) return; // Existing binding recovered; do not create another.
        if (pendingCommits.get(token) === pending) pendingCommits.delete(token);
        setCommitNotice('passkeyRetryAcknowledged');
        continued = true;
        // Explicitly acknowledged retry starts a new ceremony. It does not
        // retry the old commit or delete a possibly successful credential.
        window.setTimeout(() => {
          if (current()) openBinding();
        }, 0);
      },
    });
  }
  function remove(credential) {
    open({ title: t('passkeyRemove'), description: t('passkeyRemoveDescription', { label: credential.label || t('passkeyUnnamed') }),
      danger: true, submit: t('passkeyRemove'), onSubmit: async () => {
        const operation = begin();
        const localContext = { ...config, ...credential };
        // A confirmed trusted revoke locks its originating session immediately.
        // Later navigation/account switches must not redirect this action.
        if (credential.mode === 'trusted_browser') onCancelUnlock?.();
        try {
          // The explicit mutation may complete after its dialog is dismissed.
          // Acknowledged local cleanup is therefore not tied to UI cancellation.
          await request('/remove', { method: 'POST', body: { credential_id: credential.credential_id },
            ...(credential.mode === 'trusted_browser' ? {} : { signal: operation.signal }) });
          if (credential.mode === 'trusted_browser') {
            try { await trustedKeyStore.remove(localContext); }
            catch { notify(t('trustedCleanupFailed')); throw new Error(t('trustedCleanupFailed')); }
          }
          if (!operation.isCurrent() || operation.signal.aborted) return;
          await load(operation.signal); operation.current(); notify(t('passkeyRemoved'));
        } finally { finish(operation); }
      },
    });
  }

  const picker = config?.credentials?.length > 1 && <label className="field">{t('passkeyChoose')}
    <select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
      {config.credentials.map(credential => <option key={credential.credential_id} value={credential.credential_id}>{credential.label || t('passkeyUnnamed')}</option>)}
    </select></label>;
  const controls = <>
    {picker}
    <div className="key-actions">
      <Button icon={Key} disabled={!canTry || !selected || busy || unlocked} onClick={unlock}>{t('passkeyUnlock')}</Button>
      {busy && <Button icon={X} onClick={cancel}>{t('cancel')}</Button>}
    </div>
    {stage && <p role="status">{t(stage)}</p>}
    {commitNotice && <Note tone={commitNotice === 'passkeyCommitUnknown' ? 'amber' : ''}>{t(commitNotice)}</Note>}
    {mode === 'manage' && <Button onClick={() => load().catch(error => {
      if (mounted.current && readToken(USER_KEY) === token) {
        if (pendingCommits.has(token)) setCommitNotice('passkeyCommitUnknown');
        else setError(errorText(error));
      }
    })}>{t('passkeyRefresh')}</Button>}
    {pendingCommits.has(token) && <Button disabled={busy} onClick={retryUnknown}>{t('passkeyRetryUnknown')}</Button>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </>;
  if (mode !== 'manage') return <div className="passkey-unlock">{controls}
    {config && (!canTry || !selected) && <small>{t(!available ? 'passkeyUnavailable' : !config.enabled ? 'passkeyDisabled' : 'passkeyNoCredentials')}</small>}
  </div>;
  return <section className="panel key-panel">
    <div className="section-top"><h2>{t('passkeyTitle')}</h2></div>
    <p>{t('passkeyDescription')}</p>
    {config?.trusted_browser_enabled && <Note tone="amber">{t('trustedBrowserConsent')}</Note>}
    <Note>{t('passkeyKeepRecovery')}</Note>
    <Note tone="amber"><p>{t('passkeyPrfRequirement')}</p><p>{t('passkeyPrfCompatibility')} <a href="https://github.com/bitwarden/clients/blob/browser-v2026.9.1/apps/browser/src/autofill/fido2/utils/webauthn-utils.ts#L38-L40" target="_blank" rel="noopener noreferrer">{t('passkeyPrfSource')}</a></p></Note>
    {!available && <p>{t('passkeyUnavailable')}</p>}
    {config && !config.enabled && <p>{t('passkeyDisabled')}</p>}
    {config?.credentials?.length ? <ul className="passkey-list">
      {config.credentials.map(credential => <li key={credential.credential_id}>
        <span>{credential.label || t('passkeyUnnamed')}{credential.mode === 'trusted_browser' && <small> · {t(localTrusted.some(k => k.device_id === credential.device_id && k.key_generation === credential.key_generation) ? 'trustedBrowserHere' : 'trustedBrowserElsewhere')}</small>}</span>
        <Button danger icon={Trash} disabled={busy} onClick={() => remove(credential)}>{t('passkeyRemove')}</Button>
      </li>)}
    </ul> : <p>{t('passkeyNoCredentials')}</p>}
    {localTrusted.length > 0 && <Button disabled={busy} onClick={() => open({ title: t('trustedForget'), description: t('trustedForgetDescription'), submit: t('trustedForget'), danger: true, onSubmit: async () => {
      active.current?.abort(); onCancelUnlock?.(); await trustedKeyStore.clearAccount(config.account_id);
      if (mounted.current) setLocalTrusted([]); notify(t('trustedForgotten'));
    } })}>{t('trustedForget')}</Button>}
    <div className="key-actions"><Button icon={Plus} disabled={!canTry || !hasVault || busy || pendingCommits.has(token)} onClick={openBinding}>{t('passkeyBind')}</Button></div>
    {controls}
  </section>;
}
