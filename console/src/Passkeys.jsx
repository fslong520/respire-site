import { useEffect, useRef, useState } from 'react';
import { Key, Plus, Trash, X } from '@phosphor-icons/react';
import { api, readToken, USER_KEY } from './api.js';
import { bindPasskey, unlockWithPasskey, passkeyAvailable, validatePasskeyOrigin, assertPasskeyCurrent } from './passkeys.js';
import { Button, Note, useI18n } from './ui.jsx';
import { t } from './i18n.js';

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
  const active = useRef(null);
  const mounted = useRef(true);
  const request = (path, options = {}) => api(`/api/self/passkeys${path}`, { ...options, token });
  const load = async (signal) => {
    const next = await request('', { signal });
    if (signal?.aborted || !mounted.current || readToken(USER_KEY) !== token) return;
    setConfig(next);
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
  const begin = () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const isCurrent = () => mounted.current && active.current === controller && readToken(USER_KEY) === token;
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
    let dataKey, delivered = false;
    setBusy(true); setError(''); setStage('passkeyVerifying');
    try {
      const next = await load(operation.signal);
      operation.current(); validatePasskeyOrigin(next);
      const vault = await api('/api/self/vault', { token, signal: operation.signal });
      assertPasskeyCurrent(operation.signal, isCurrent);
      dataKey = await unlockWithPasskey({ request, vault, config: next, credentialId: selected,
        signal: operation.signal, isCurrent });
      assertPasskeyCurrent(operation.signal, isCurrent);
      await onUnlock(dataKey, vault, { generation: lease.generation, isCurrent, signal: operation.signal, onAccept: () => { delivered = true; } });
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
    if (busy) return;
    const operation = begin();
    setBusy(true); setError('');
    try {
      const next = await load(operation.signal);
      operation.current(); validatePasskeyOrigin(next);
      const vault = await api('/api/self/vault', { token, signal: operation.signal });
      operation.current();
      open({
        title: t('passkeyBind'), description: t('passkeyBindDescription'),
        fields: [
          { name: 'label', label: t('passkeyLabel'), value: '', required: false },
          { name: 'superPass', label: Number(vault.version) >= 4 ? t('labelSuperA3') : t('labelSuperPass'), type: 'password' },
          ...(Number(vault.version) === 3 ? [{ name: 'secretKey', label: 'Secret Key', type: 'password' }] : []),
        ],
        submit: t('passkeyBind'),
        onDismiss: () => { operation.controller.abort(); finish(operation); },
        onSubmit: async values => {
          operation.current();
          try {
            await bindPasskey({ request, vault, config: next, label: values.label.trim().slice(0, 80) || t('passkeyUnnamed'),
              superPass: values.superPass, secretKey: values.secretKey, signal: operation.signal,
              isCurrent: operation.isCurrent, onStage: value => { operation.current(); setStage(value); } });
            operation.current();
            await load(operation.signal);
            operation.current(); notify(t('passkeyBound'));
          } catch (error) { throw new Error(errorText(error)); }
          finally { values.superPass = ''; values.secretKey = ''; setStage(''); }
        },
      });
    } catch (error) {
      if (operation.isCurrent()) setError(errorText(error));
      finish(operation);
    }
  }
  function remove(credential) {
    open({ title: t('passkeyRemove'), description: t('passkeyRemoveDescription', { label: credential.label || t('passkeyUnnamed') }),
      danger: true, submit: t('passkeyRemove'), onSubmit: async () => {
        const operation = begin();
        try {
          await request('/remove', { method: 'POST', body: { credential_id: credential.credential_id }, signal: operation.signal });
          operation.current(); await load(operation.signal); operation.current(); notify(t('passkeyRemoved'));
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
    {error && <p role="alert" className="form-error">{error}</p>}
  </>;
  if (mode !== 'manage') return <div className="passkey-unlock">{controls}
    {config && (!canTry || !selected) && <small>{t(!available ? 'passkeyUnavailable' : !config.enabled ? 'passkeyDisabled' : 'passkeyNoCredentials')}</small>}
  </div>;
  return <section className="panel key-panel">
    <div className="section-top"><h2>{t('passkeyTitle')}</h2></div>
    <p>{t('passkeyDescription')}</p>
    <Note>{t('passkeyKeepRecovery')}</Note>
    {!available && <p>{t('passkeyUnavailable')}</p>}
    {config && !config.enabled && <p>{t('passkeyDisabled')}</p>}
    {config?.credentials?.length ? <ul className="passkey-list">
      {config.credentials.map(credential => <li key={credential.credential_id}>
        <span>{credential.label || t('passkeyUnnamed')}</span>
        <Button danger icon={Trash} disabled={busy} onClick={() => remove(credential)}>{t('passkeyRemove')}</Button>
      </li>)}
    </ul> : <p>{t('passkeyNoCredentials')}</p>}
    <div className="key-actions"><Button icon={Plus} disabled={!canTry || !hasVault || busy} onClick={openBinding}>{t('passkeyBind')}</Button></div>
    {controls}
  </section>;
}
