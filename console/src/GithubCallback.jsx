import { useEffect, useState } from 'react';
import { api } from './api.js';
import { generateSecretKey, unwrapUrk, wrapVaultV4 } from './crypto.js';
import { Button, Note, useI18n } from './ui.jsx';
import { t } from './i18n.js';

const exchanges = new WeakMap();
function exchange(grant, token) {
  if (!exchanges.has(grant)) exchanges.set(grant, api(`${grant.bind ? '/api/self/github' : '/oauth/github'}/exchange`, {
    method: 'POST', token: grant.bind ? token : undefined, body: { state: grant.state, code: grant.code },
  }));
  return exchanges.get(grant);
}

export function GithubCallback({ grant, token, authorization, onEnter, onDone }) {
  useI18n();
  const [reply, setReply] = useState(null);
  const [error, setError] = useState(grant.error || '');
  const [busy, setBusy] = useState(!grant.error);
  const [code, setCode] = useState('');
  const [superpass, setSuper] = useState('');
  const [vault, setVault] = useState(undefined);
  const [issued, setIssued] = useState('');
  const [saved, setSaved] = useState(false);

  async function prepare(result) {
    setReply(result);
    if (result.totp_required) return;
    let existingVault;
    try { existingVault = await api('/api/self/vault', { token: result.token }); setVault(existingVault); }
    catch (err) { if (err.status === 404) setVault(null); else throw err; }
    // CLI/TUI supplies its recovery code in the terminal, after browser approval.
    if (authorization && existingVault) await onEnter({ token: result.token });
  }

  useEffect(() => {
    if (grant.error) return;
    let active = true;
    exchange(grant, token).then(async (result) => {
      if (!active) return;
      if (grant.bind) onDone();
      else await prepare(result);
    }).catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (reply?.totp_required) {
        await prepare(await api('/login/totp', { method: 'POST', body: { ticket: reply.ticket, code, device_name: 'dashboard' } }));
        setCode('');
      } else if (issued) {
        if (!saved) throw new Error(t('confirmSuperFirst'));
        await api('/api/self/github/vault', { method: 'POST', token: reply.token, body: vault });
        await onEnter({ token: reply.token, superPass: issued });
      } else if (vault === null) {
        const recovery = generateSecretKey();
        const initialVault = await wrapVaultV4(recovery);
        setVault(initialVault); setIssued(recovery);
      } else {
        await unwrapUrk(superpass, undefined, vault);
        await onEnter({ token: reply.token, superPass: superpass });
      }
    } catch (err) { setError(err.name === 'OperationError' ? t('githubUnlockFailed') : err.message); }
    finally { setBusy(false); }
  }

  return <div className="gate-page" style={{ padding: 48 }}><section className="panel form-panel">
    <h1>{reply?.totp_required ? t('totpTitle') : t('githubContinue')}</h1>
    {busy && <p>{t('checkingLogin')}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {reply && !grant.bind && <form onSubmit={submit}>
      <p>{reply.user}</p>
      {reply.totp_required ? <label className="field">{t('totpCode')}<input autoFocus required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></label>
        : issued ? <><Note tone="amber">{t('copySuperNow')}</Note><div className="demo-key"><code>{issued}</code></div><label className="check-label"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />{t('confirmSavedSuper')}</label></>
          : vault === null ? <Note tone="amber">{t('clickGenerateSuper')}</Note>
            : vault ? <label className="field">{t('superPassword')}<input autoFocus required type="password" autoComplete="off" value={superpass} onChange={e => setSuper(e.target.value)} /></label> : null}
      <Button primary disabled={busy || (!reply.totp_required && vault === undefined) || (!!issued && !saved)} type="submit">{reply.totp_required ? t('verify') : vault === null ? t('generateSuper') : t('continue')}</Button>
    </form>}
    <Button disabled={busy} onClick={onDone}>{t('backToLogin')}</Button>
  </section></div>;
}
