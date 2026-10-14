import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Brand } from './Brand.jsx';
import { Button, LangSwitch, useI18n } from './ui.jsx';
import { t } from './i18n.js';

export function CliAuthorization({ token, code: linkCode, onLogout }) {
  useI18n();
  const [code, setCode] = useState(linkCode);
  const [request, setRequest] = useState(null);
  const [user, setUser] = useState('');
  const [error, setError] = useState('');
  const [decision, setDecision] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Fa-f0-9]{12}$/.test(code);
  useEffect(() => {
    const controller = new AbortController();
    setRequest(null); setDecision(''); setError('');
    if (valid) Promise.all([
      api(`/api/self/cli-authorization/${code}`, { token, signal: controller.signal }),
      api('/api/self', { token, signal: controller.signal }),
    ]).then(([info, account]) => {
      if (!controller.signal.aborted) { setRequest(info); setUser(account.user); }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [token, code, valid]);
  async function decide(approve) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api(`/api/self/cli-authorization/${code}`, { method: 'POST', token, body: { approve } });
      setDecision(approve ? 'approved' : 'denied');
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="gate-page user-login">
    <header><Brand href={import.meta.env.VITE_HOMEPAGE_URL} /><LangSwitch /></header>
    <section className="gate-form panel" style={{ margin: '48px auto', maxWidth: 560 }}>
      <h2>{t('cliAuthorizeTitle')}</h2>
      {!decision && <label className="field">{t('cliAuthorizeEnterCode')}<input autoFocus disabled={busy} value={code} maxLength={12} onChange={event => setCode(event.target.value.trim())} autoComplete="off" /></label>}
      {!valid ? null : decision ?
        <p role="status">{t(decision === 'approved' ? 'cliAuthorizeDone' : 'cliAuthorizeDenied')}</p> : <>
          <p>{t('cliAuthorizeDescription')}</p>
          {request ? <>
            <p>{t('username')}: {user}</p>
            <p>{t('cliAuthorizeDevice')}: {request.device_name}</p>
            <div className="setup-key"><code>{code.toUpperCase()}</code></div>
            <p>{t('cliAuthorizeCompare')}</p>
            <Button primary disabled={busy || request.state !== 'pending' || (!!request.expected_user && request.expected_user !== user)} onClick={() => decide(true)}>{t('cliAuthorizeApprove')}</Button>
            <Button disabled={busy || request.state !== 'pending'} onClick={() => decide(false)}>{t('cliAuthorizeDeny')}</Button>
          </> : !error ? <p>{t('checkingLogin')}</p> : null}
          {error && <p className="form-error" role="alert">{error}</p>}
          <Button disabled={busy} onClick={onLogout}>{t('cliAuthorizeChangeAccount')}</Button>
        </>}
    </section>
  </div>;
}
