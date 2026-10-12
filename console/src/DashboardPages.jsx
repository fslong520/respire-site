import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TreeStructure, Clock, MagnifyingGlass, CaretRight, LockKey, ShieldCheck,
  CloudCheck, Desktop, Terminal, Plus, Key, Copy, Check, DownloadSimple,
  SignOut, ArrowClockwise, Article, ArrowLeft, X, WarningCircle, PencilSimple, Trash,
  ListBullets, CaretDown, BookOpen, SquaresFour, Compass, ListChecks, Heart, Wrench, Smiley, Tag,
} from '@phosphor-icons/react';
import { Button, Badge, Heading, Empty, Note, SecretResult, copy, download, useI18n } from './ui.jsx';
import { decryptItem, deriveDataKeys, encryptItem, generateSecretKey, unwrapUrk, wrapVaultV4 } from './crypto.js';
import { api, readToken, USER_KEY, hasLegacyRecovery, exportLegacyRecovery, clearLegacyRecovery } from './api.js';
import { MemorySync } from './memorySync.js';
import { Security } from './Security.jsx';
import { buildIndex, childrenOf, subtreeCount, diaryDays, visibleRows, ROOT_ID, DIARY_ID } from './treeModel.js';
import { t, getLocale, kindLabel } from './i18n.js';
import { readUnlockSession, saveUnlockSession, dropUnlockSession } from './unlockSession.js';

/** Normalize tags: CLI payloads may use CSV, while browser editing uses arrays. */
function toTagList(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

/** One icon per memory kind, falling back to Article for unknown kinds. */
const KIND_ICONS = {
  context: Article,
  decision: Compass,
  task: ListChecks,
  preference: Heart,
  skill: Wrench,
  emotion: Smiley,
  time: Clock,
};

/** Badge tone per memory kind for the card view; undefined keeps the neutral badge. */
const KIND_TONES = {
  context: 'purple',
  decision: 'purple',
  task: 'green',
  preference: 'amber',
  skill: 'green',
  emotion: 'red',
  time: undefined,
};

/** Rows per page for the list/card pagers. */
const PAGE_SIZE = 24;

/** Shared pager for the list and card views: prev/next with a page indicator. */
function Pager({ total, page, onPage, labels }) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pageCount <= 1) return null;
  return (
    <nav className="pager" aria-label={labels.pager}>
      <button className="pager-step" disabled={page <= 1} onClick={() => onPage(page - 1)}>{labels.prev}</button>
      <span className="pager-state">{labels.pageOf.replace('{n}', String(page)).replace('{total}', String(pageCount))}</span>
      <button className="pager-step" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>{labels.next}</button>
    </nav>
  );
}

import DiaryCalendar from './DiaryCalendar.jsx';

function EmptyInstallHint() {
  return <Note icon={Terminal}><a href="https://github.com/risense-ai/respire-docs" target="_blank" rel="noreferrer">{t('docsHelp')}</a></Note>;
}

/** Onboarding card shown in the list/tree/card area while the vault is empty. */
function EmptyGuide({ notify }) {
  const steps = [
    { cmd: 'npm i -g @rsrsai/cli', label: t('guideStepInstall'), desc: t('guideStepInstallDesc') },
    { cmd: 'rsrs doctor', label: t('guideStepDoctor'), desc: t('guideStepDoctorDesc') },
  ];
  return (
    <div className="empty-guide">
      <p className="guide-empty-note">{t('emptyNotice')}</p>
      <h3>{t('guideTitle')}</h3>
      <p className="guide-sub">{t('guideSub')}</p>
      <ol className="guide-steps">
        {steps.map(({ cmd, label, desc }) => (
          <li key={cmd}>
            <span className="guide-label">{label}</span>
            <div className="guide-cmd">
              <code>{cmd}</code>
              <button className="icon-button" aria-label={t('copySuper')} onClick={() => copy(cmd, notify)}><Copy size={15} /></button>
            </div>
            <p>{desc}</p>
          </li>
        ))}
        <li>
          <span className="guide-label">{t('guideStepSave')}</span>
          <p>{t('guideStepSaveDesc')}</p>
        </li>
      </ol>
      <p className="guide-views">{t('guideViews')}</p>
    </div>
  );
}
export function DashboardPages({
  page, memoryId, token, me, sessions, keys, notify, open, go, onReload, onToken, onLogout,
}) {
  useI18n();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null);
  const [listPage, setListPage] = useState(1);
  const openMemory = (id) => go(id ? `memories/${encodeURIComponent(id)}` : 'memories');
  const [locked, setLocked] = useState(true);
  const [tick, setTick] = useState(0);
  const [vaultInfo, setVaultInfo] = useState(undefined);
  const [viewMode, setViewMode] = useState('tree');
  const [expanded, setExpanded] = useState(() => new Set([ROOT_ID, DIARY_ID]));
  const list = useMemo(() => (items || []).filter((m) => [m.title, m.content, m.kind, m.project].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase())), [items, query]);
  useEffect(() => {
    setListPage(current => Math.min(current, Math.max(1, Math.ceil(list.length / PAGE_SIZE))));
  }, [list.length]);
  // Memoize indexes and search results because TreeBranch depends on index identity.
  // Rebuilding them on every render would reset expanded child rows.
  const treeSource = useMemo(() => {
    const all = items || [];
    if (!query) return all;
    const q = query.toLowerCase();
    const hit = new Set();
    all.forEach((m) => {
      const hay = [m.title, m.content, m.kind, m.project, toTagList(m.tags).join(' ')].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) hit.add(m.id);
    });
    const byId = new Map(all.map((m) => [m.id, m]));
    const keep = new Set(hit);
    hit.forEach((id) => {
      let cur = byId.get(id);
      let guard = 0;
      while (cur && cur.parent_id && guard++ < 64) {
        keep.add(cur.parent_id);
        cur = byId.get(cur.parent_id);
      }
    });
    return all.filter((m) => keep.has(m.id));
  }, [items, query]);
  // Keep text matches and their ancestors visible during search.
  const forceIds = useMemo(() => {
    if (!query) return null;
    const all = items || [];
    const q = query.toLowerCase();
    const keep = new Set();
    all.forEach((m) => {
      const hay = [m.title, m.content, m.kind, m.project, toTagList(m.tags).join(' ')].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return;
      keep.add(m.id);
      let cur = m;
      let guard = 0;
      const byId = new Map(all.map((x) => [x.id, x]));
      while (cur && cur.parent_id && guard++ < 64) {
        keep.add(cur.parent_id);
        cur = byId.get(cur.parent_id);
      }
    });
    return keep;
  }, [items, query]);
  const treeIndex = useMemo(() => {
    const idx = buildIndex(treeSource);
    if (forceIds) idx.forceIds = forceIds;
    return idx;
  }, [treeSource, forceIds]);
  // Compute visible rows once, descending only into expanded levels.
  const treeRows = useMemo(() => visibleRows(treeIndex, expanded), [treeIndex, expanded]);
  // Parent candidates for the new/edit forms: folders and category-like roots, not trivial diary rows.
  const parentOptions = useMemo(() => (items || [])
    .filter((m) => m.importance !== 'trivial')
    .map((m) => ({ value: m.id, label: m.title || String(m.id).slice(0, 8) })), [items]);
  const dataKeyRef = useRef(null);
  const memorySyncRef = useRef(null);
  const unlockGeneration = useRef(0);
  const [syncing, setSyncing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [lastSync, setLastSync] = useState(null);
  useEffect(() => () => {
    unlockGeneration.current++;
    memorySyncRef.current?.close();
    dataKeyRef.current = null;
  }, [token]);
  const saveMemory = async (payload, existingId) => {
    const dataKey = dataKeyRef.current;
    if (!dataKey) throw new Error(t('pleaseUnlock'));
    const now = new Date().toISOString();
    const id = existingId || crypto.randomUUID();
    const pt = JSON.stringify(payload);
    const { nonce, ciphertext } = await encryptItem(dataKey, pt);
    // The browser leaves embedding_enc empty; the CLI/Core builds the retrieval index after sync.
    // api() returns JSON and throws for non-2xx responses.
    await api('/push', { method: 'POST', body: { id, ciphertext, nonce, embedding_enc: '', updated_at: now, deleted: false }, token });
    // Newly pushed revisions exceed the cursor; merge incrementally rather than unlock everything again.
    await syncIncremental();
    return id;
  };
  const deleteMemory = async (id) => {
    await api('/forget', { method: 'POST', body: { id }, token });
    // forget writes a tombstone and advances the revision for incremental deletion.
    await syncIncremental();
  };
  const keyStored = !!readUnlockSession(token);
  const legacyRecovery = hasLegacyRecovery();
  const hasVault = !!(vaultInfo && vaultInfo.wrapped_urk);

  useEffect(() => {
    if (page !== 'keys') return;
    api('/api/self/vault', { token })
      .then(setVaultInfo)
      .catch((e) => {
        if (e.status === 404) setVaultInfo(null);
        else notify(e.message);
      });
  }, [page, token, tick]);

  const unlockMemories = async (pass, secret, session) => {
    const generation = ++unlockGeneration.current;
    memorySyncRef.current?.close();
    const vault = await api('/api/self/vault', { token });
    const v = Number(vault.version) || 0;
    let dataKey;
    if (session) {
      if (session.vault !== JSON.stringify(vault)) {
        dropUnlockSession(token);
        throw new Error(t('pleaseUnlock'));
      }
      dataKey = session.dataKey;
    } else {
      if (v >= 4 && !pass) throw new Error(t('needSuper'));
      if (v === 3 && !pass) throw new Error(t('needSuperV3'));
      if (v === 3 && !secret) throw new Error(t('needSecretV3'));
      const urk = await unwrapUrk(pass, secret, vault);
      try { dataKey = await deriveDataKeys(urk, vault.wrapped_urk.startsWith('rsrs:v1:')); }
      finally { urk.fill(0); }
    }
    const decryptKey = {
      legacy: await crypto.subtle.importKey('raw', dataKey.legacy, 'AES-GCM', false, ['decrypt']),
      current: await crypto.subtle.importKey('raw', dataKey.current, 'AES-GCM', false, ['decrypt']),
    };
    if (generation !== unlockGeneration.current || readToken(USER_KEY) !== token) {
      throw new DOMException('Unlock superseded', 'AbortError');
    }
    dataKeyRef.current = dataKey;
    setLoadError('');
    let firstResolve;
    let firstReject;
    let displayed = false;
    const firstBatch = new Promise((resolve, reject) => { firstResolve = resolve; firstReject = reject; });
    const controller = new MemorySync({
      token, vault,
      isCurrent: () => dataKeyRef.current === dataKey && readToken(USER_KEY) === token
        && memorySyncRef.current === controller,
      onLoading: setSyncing,
      onCacheError: () => notify(t('memoryCacheUnavailable')),
      onReset: () => setItems([]),
      onBlobs: async (blobs, signal) => {
        let failed = 0;
        // Small batches yield between paints, with one imported key per unlocked session.
        for (let offset = 0; offset < Math.max(blobs.length, 1); offset += 25) {
          const changes = await Promise.all(blobs.slice(offset, offset + 25).map(async (blob) => {
            if (blob.deleted) return [blob.id, null];
            try {
              const payload = JSON.parse(await decryptItem(decryptKey, blob.ciphertext, blob.nonce));
              return [blob.id, { ...payload, id: blob.id }];
            } catch { failed++; return null; }
          }));
          controller.current();
          signal.throwIfAborted();
          setItems((prev) => {
            const next = new Map((prev || []).map((m) => [m.id, m]));
            for (const change of changes) {
              if (!change) continue;
              const [id, memory] = change;
              if (memory === null) next.delete(id);
              else next.set(id, memory);
            }
            return [...next.values()];
          });
          setLocked(false);
          saveUnlockSession(token, vault, dataKey);
          if (!displayed) {
            displayed = true;
            firstResolve();
          }
          await new Promise(resolve => window.setTimeout(resolve, 0));
        }
        if (failed) notify(t('newCipherFail', { n: failed }));
      },
    });
    memorySyncRef.current = controller;
    controller.start().then(() => {
      controller.current();
      setLastSync(Date.now());
    }).catch((error) => {
      if (!displayed) firstReject(error);
      if (error.name === 'AbortError') return;
      setLoadError(t('memoryLoadInterrupted'));
      if (displayed) notify(error.message);
    });
    await firstBatch;
  };

  // Refresh and writes share the same bounded incremental stream.
  const syncIncremental = async () => {
    const controller = memorySyncRef.current;
    if (!controller || !dataKeyRef.current) return;
    try {
      await controller.sync();
      controller.current();
      setLoadError('');
      setLastSync(Date.now());
    } catch (error) {
      if (error.name === 'AbortError') return;
      setLoadError(t('memoryLoadInterrupted'));
      throw error;
    }
  };

  // Locking clears key material and invalidates in-flight sync by dataKeyRef identity.
  // Never render returned plaintext after the user locks the view.
  const lockMemories = () => {
    dropUnlockSession(token);
    unlockGeneration.current++;
    memorySyncRef.current?.close();
    memorySyncRef.current = null;
    dataKeyRef.current = null;
    setSyncing(false);
    setLoadError('');
    setLocked(true);
    setItems(null);
  };

  // Poll every four seconds while unlocked; pause when hidden and sync on becoming visible.
  // Skip polling while locked.
  const unlocked = !locked && items !== null;
  useEffect(() => {
    if (!unlocked) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try { await syncIncremental(); } catch { /* Global handling reports network/auth errors; retry on the next poll */ }
      }
      if (!stopped) timer = window.setTimeout(tick, 4000);
    };
    timer = window.setTimeout(tick, 4000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        // syncIncremental propagates rejections; attach .catch for asynchronous calls.
        syncIncremental().catch(() => { /* Retry transient network errors on the next poll */ });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [unlocked, token]);

  useEffect(() => {
    if (page !== 'memories') return;
    if (items !== null) return;
    const session = readUnlockSession(token);
    if (!session) return;
    unlockMemories('', '', session).catch((e) => {
      if (e.name === 'AbortError') return;
      setLocked(true);
      const why = String(e.message || e);
      const hint = e.status === 404
        ? t('noVault')
        : why.includes('Secret Key')
          ? t('missingSecret')
          : t('unlockFail', { why });
      notify(hint);
    });
  }, [page, token]);

  const openNewMemory = () => open({
    title: t('saveOne'),
    icon: Plus,
    description: t('saveOneDesc'),
    fields: [
      { name: 'title', label: t('fieldTitle'), required: true, placeholder: t('titlePh') },
      { name: 'content', label: t('fieldContent'), type: 'textarea', rows: 8, required: true, placeholder: t('contentPh') },
      { name: 'kind', label: t('fieldKind'), options: [
        { value: 'context', label: t('kindContext') },
        { value: 'decision', label: t('kindDecision') },
        { value: 'task', label: t('kindTask') },
        { value: 'preference', label: t('kindPreference') },
        { value: 'skill', label: t('kindSkill') },
        { value: 'emotion', label: t('kindEmotion') },
        { value: 'time', label: t('kindTime') },
      ] },
      { name: 'importance', label: t('fieldImportance'), options: [['important', 'important'], ['trivial', 'trivial']] },
      { name: 'project', label: t('fieldProject'), required: false },
      { name: 'parent', label: t('fieldParent'), type: 'select', required: false, options: [
        { value: '', label: t('parentRoot') },
        ...parentOptions.filter((o) => o.value !== ''),
      ] },
      { name: 'tags', label: t('fieldTags'), required: false },
    ],
    onSubmit: async (v) => {
      await saveMemory({
        kind: v.kind, title: v.title, content: v.content, importance: v.importance,
        tags: v.tags, project: v.project, parent_id: v.parent || '',
        user: me?.user || '', computer: 'dashboard', device: 'dashboard', modified_by: 'dashboard',
        emotion: -1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      notify(t('uploaded'));
    },
    submit: t('encryptUpload'),
  });
  const openEditMemory = (m) => open({
    title: t('editMemory'),
    icon: PencilSimple,
    fields: [
      { name: 'title', label: t('fieldTitle'), required: true, value: m.title || '' },
      { name: 'content', label: t('fieldContent'), type: 'textarea', rows: 8, required: true, value: m.content || '' },
      { name: 'kind', label: t('fieldKind'), options: [
        { value: 'context', label: t('kindContext') },
        { value: 'decision', label: t('kindDecision') },
        { value: 'task', label: t('kindTask') },
        { value: 'preference', label: t('kindPreference') },
        { value: 'skill', label: t('kindSkill') },
        { value: 'emotion', label: t('kindEmotion') },
        { value: 'time', label: t('kindTime') },
      ], value: m.kind || 'context' },
      { name: 'importance', label: t('fieldImportance'), options: [['important', 'important'], ['trivial', 'trivial']], value: m.importance === 'trivial' ? 'trivial' : 'important' },
      { name: 'project', label: t('fieldProject'), required: false, value: m.project || '' },
      { name: 'parent', label: t('fieldParent'), type: 'select', required: false, value: m.parent_id || '', options: [
        { value: '', label: t('parentRoot') },
        ...parentOptions.filter((o) => o.value !== m.id),
      ] },
      { name: 'tags', label: t('fieldTags'), required: false, value: toTagList(m.tags).join(',') },
    ],
    onSubmit: async (v) => {
      await saveMemory({
        ...m,
        kind: v.kind, title: v.title, content: v.content, importance: v.importance,
        tags: v.tags ? v.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        project: v.project,
        parent_id: v.parent || '',
        updated_at: new Date().toISOString(), modified_by: 'dashboard',
      }, m.id);
      openMemory(null);
      notify(t('savedEdit'));
    },
    submit: t('saveEdit'),
  });
  const openUnlock = async () => {
    let vault = {};
    try { vault = await api('/api/self/vault', { token }); } catch { /* Report a missing vault on submission */ }
    const v = Number(vault.version) || 0;
    const fields = v >= 4
      ? [{ name: 'pass', label: t('labelSuperA3'), type: 'password', value: '' }]
      : [
          { name: 'pass', label: t('labelSuperPass'), type: 'password', value: '' },
          { name: 'secret', label: 'Secret Key', type: 'password', value: '', required: false },
        ];
    open({
      title: t('unlockTitle'),
      icon: LockKey,
      description: (
        (v >= 4
          ? t('unlockV4')
          : t('unlockV3'))
        + t('unlockTail')
      ),
      fields,
      onSubmit: async (vals) => {
        await unlockMemories(vals.pass, vals.secret);
        notify(t('unlockedHere'));
      },
      submit: t('unlockView'),
    });
  };

  if (page === 'diary') {
    const all = items || [];
    const trivials = all.filter((m) => m.importance === 'trivial');
    const dayMap = new Map();
    trivials.forEach((m) => {
      const trail = (m.title || '').match(/^活动轨迹 (\d{4}-\d{2}-\d{2})$/);
      const iso = m.created_at || m.updated_at || '';
      const d = new Date(iso);
      const localDay = Number.isNaN(d.getTime())
        ? String(iso).slice(0, 10)
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const day = (trail && trail[1]) || localDay || 'unknown-date';
      if (!dayMap.has(day)) dayMap.set(day, []);
      dayMap.get(day).push({ id: m.id, title: m.title || t('untitled') });
    });
    const days = [...dayMap.keys()].sort().reverse().map((day) => ({ day, items: dayMap.get(day) }));
    if (locked && items === null) {
      return (
        <>
          <Heading eyebrow="YOUR DIARY / ACTIVITY" title={t('diaryTitle')} description={t('diaryDesc')} />
          <section className="locked-state panel">
            <div className="large-mark"><BookOpen size={40} /></div>
            <Badge tone="purple">{t('e2e')}</Badge>
            <h2>{t('diaryLockedH2')}</h2>
            <p>{t('diaryLockedP')}</p>
            <Button primary icon={Key} onClick={openUnlock}>{t('unlockMemory')}</Button>
          </section>
        </>
      );
    }
    return (
      <>
        <Heading eyebrow="YOUR DIARY / ACTIVITY" title={t('diaryTitle')} description={t('diaryCount', { n: trivials.length, d: days.length })}>
          <Button icon={ArrowLeft} onClick={() => go('memories')}>{t('backToTree')}</Button>
        </Heading>
        <section className="panel" style={{ padding: 22 }}>
          <DiaryCalendar days={days} onOpenMemory={(id) => openMemory(id)} />
        </section>
      </>
    );
  }

  if (page === 'memories') {
    const mem = (items || []).find((m) => m.id === memoryId);
    if (locked && items === null) {
      return (
        <>
          <Heading eyebrow="YOUR MEMORY / YOUR CONTEXT" title={t('myMemory')} description={t('myMemoryDesc')} />
          <section className="locked-state panel">
            <div className="large-mark"><LockKey size={40} /></div>
            <Badge tone="purple">{t('e2e')}</Badge>
            <h2>{t('lockedH2')}</h2>
            <p>
              {t('lockedP')}
            </p>
            <Button primary icon={Key} onClick={openUnlock}>{t('unlockMemory')}</Button>
            <span>{t('memoryOnlyDescription')}</span>
            {legacyRecovery ? <Button onClick={() => go('keys')}>{t('legacyRecoveryClear')}</Button> : null}
          </section>
        </>
      );
    }
    const emptyVault = Array.isArray(items) && items.length === 0;
    return (
      <>
        <Heading eyebrow="YOUR MEMORY / YOUR CONTEXT" title={mem ? (mem.title || t('untitled')) : t('myMemory')} description={mem ? undefined : t('myMemoryDesc')}>
          {mem ? <Button icon={ArrowLeft} onClick={() => openMemory(null)}>{t('backMemory')}</Button> : (
            <>
              <Button primary icon={Plus} onClick={openNewMemory}>{t('saveMemory')}</Button>
              <Button icon={ArrowClockwise} onClick={() => syncIncremental().then(() => notify(t('pulled'))).catch((e) => notify(e.message))}>{t('pullLatest')}</Button>
              <Button icon={LockKey} onClick={() => { lockMemories(); openMemory(null); notify(t('locked')); }}>{t('lock')}</Button>
            </>
          )}
        </Heading>
        {mem ? (
          <div className="memory-reading">
            <article className="reading-main">
              <div className="reading-meta"><Badge tone="purple">{kindLabel(mem.kind) || t('memoryKind')}</Badge><span>{mem.project || '—'} · {mem.updated_at || mem.created_at}</span></div>
              <h2>{t('memoryBody')}</h2>
              {renderContent(mem.content)}
              <div className="reading-footer"><LockKey size={17} />{t('onlyHere')}</div>
            </article>
            <aside className="inspector panel">
              <div className="section-top"><h2>{t('memoryInfo')}</h2></div>
              <dl className="details">
                <div><dt>{t('memoryType')}</dt><dd>{kindLabel(mem.kind) || '—'}</dd></div>
                <div><dt>{t('project')}</dt><dd>{mem.project || '—'}</dd></div>
                <div><dt>{t('updatedAt')}</dt><dd>{mem.updated_at || mem.created_at || '—'}</dd></div>
                <div><dt>{t('memoryId')}</dt><dd><button className="copy-id" title={mem.id} onClick={() => copy(mem.id, notify)}>{mem.id.slice(0, 8)}…<Copy size={15} /></button></dd></div>
              </dl>
              <Note>{t('inspectNote')}</Note>
              <div className="key-actions">
                <Button icon={PencilSimple} onClick={() => openEditMemory(mem)}>{t('edit')}</Button>
              </div>
              <Button danger icon={Trash} onClick={() => open({
                title: t('deleteMemoryQ'),
                description: t('deleteMemoryDesc', { title: mem.title || t('untitled') }),
                danger: true,
                fields: [{ name: 'confirm', label: t('typeDelete') }],
                validate: (v) => (v.confirm !== t('deleteWord') ? t('pleaseTypeDelete') : null),
                onSubmit: async () => { await deleteMemory(mem.id); openMemory(null); notify(t('deleted')); },
                submit: t('deleteWord'),
              })}>{t('deleteMemory')}</Button>
            </aside>
          </div>
        ) : (
          <>
            {emptyVault && !syncing && !loadError && <EmptyInstallHint notify={notify} />}
            {(loadError || syncing) && <div className="memory-tip" role={loadError ? 'alert' : 'status'}>
              {loadError ? <WarningCircle size={20} /> : <ArrowClockwise size={20} />}
              <span>{loadError || t('memoryLoading', { n: (items || []).length })}</span>
            </div>}
            <div className="memory-status">
              <span><CloudCheck size={22} />{t('cloudReady')}</span>
              <span>{t('nMemories', { n: (items || []).length })}</span>
              <span className="green-text"><ShieldCheck size={18} />{t('browserUnlocked')}</span>
              <span className={`sync-indicator${syncing ? ' is-syncing' : ''}`}>
                <span className="sync-dot" aria-hidden="true" />
                {syncing ? t('syncing') : lastSync ? t('autoSynced', { time: new Date(lastSync).toLocaleTimeString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }) }) : t('autoSyncOn')}
              </span>
            </div>
            <section className="memory-collection panel" style={{ padding: 20 }}>
              <label className="search-box memory-search">
                <MagnifyingGlass size={21} />
                <input aria-label={t('searchMemory')} placeholder={t('searchPh')} value={query} onChange={(e) => { setQuery(e.target.value); setListPage(1); }} />
                {query && <button className="icon-button" aria-label={t('clear')} onClick={() => setQuery('')}><X size={17} /></button>}
              </label>
              <div className="collection-title">
                <h2>{query ? t('searchResults') : (viewMode === 'tree' ? t('memoryTree') : viewMode === 'card' ? t('memoryCards') : t('allMemories'))}</h2>
                <div className="collection-tools">
                  <div className="tabs view-tabs" role="tablist" aria-label={t('viewSwitcher')}>
                    {[['tree', TreeStructure, t('treeView')], ['list', ListBullets, t('listView')], ['card', SquaresFour, t('cardView')]].map(([mode, Icon, label]) => (
                      <button key={mode} role="tab" aria-selected={viewMode === mode} className={viewMode === mode ? 'active' : ''} onClick={() => setViewMode(mode)} title={label}>
                        <Icon size={15} />
                        <span className="view-tab-label">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {emptyVault ? (
                <EmptyGuide notify={notify} />
              ) : query && list.length ? (
                <div className="search-results">
                  {list.slice(0, 200).map((m) => {
                    const path = [];
                    let cur = m;
                    let guard = 0;
                    const byId = new Map((items || []).map((x) => [x.id, x]));
                    while (cur && cur.parent_id && guard++ < 32) {
                      const par = byId.get(cur.parent_id);
                      if (!par) break;
                      path.unshift(par.title || t('untitled'));
                      cur = par;
                    }
                    return (
                      <button key={m.id} className="search-hit" onClick={() => openMemory(m.id)}>
                        <Article size={16} />
                        <span className="hit-main">
                          <strong>{m.title || t('untitled')}</strong>
                          <small>{(m.content || '').replace(/\s+/g, ' ').slice(0, 90)}</small>
                          {path.length ? <em>{path.join(' › ')}</em> : null}
                        </span>
                      </button>
                    );
                  })}
                  {list.length > 200 ? <p className="hit-more">{t('hitMore', { n: list.length })}</p> : null}
                </div>
              ) : viewMode === 'card' && list.length ? (
                <div className="memory-cards">
                  {list.slice((listPage - 1) * PAGE_SIZE, listPage * PAGE_SIZE).map((m) => {
                    const tags = toTagList(m.tags);
                    const when = m.updated_at || m.created_at || '';
                    const whenText = when ? new Date(when).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }) : '—';
                    const KindIcon = KIND_ICONS[m.kind] || Article;
                    const tone = KIND_TONES[m.kind];
                    return (
                      <button key={m.id} data-kind={m.kind} className={`memory-card${memoryId === m.id ? ' active' : ''}`} onClick={() => openMemory(m.id)}>
                        <span className={`badge${tone ? ` ${tone}` : ''}`}><KindIcon size={11} />{kindLabel(m.kind) || t('memoryKind')}</span>
                        <strong>{m.title || t('untitled')}</strong>
                        <p>{(m.content || '').replace(/\s+/g, ' ').slice(0, 140)}</p>
                        <small>
                          <span>{m.project || '—'}</span>
                          <span>{whenText}</span>
                          {tags.length ? <span className="hit-tags"><Tag size={10} />{tags.join(', ')}</span> : null}
                        </small>
                      </button>
                    );
                  })}
                </div>
              ) : viewMode === 'tree' && treeSource.length ? (
                <div className="tree-view">
                  {treeRows.map(({ row, depth, open, hasKids }) => (
                    <div key={row.id} className={`tree-row${memoryId === row.memoryId ? ' active' : ''}`} style={{ paddingLeft: 4 + depth * 16 }}>
                      {hasKids ? (
                        <button className="tree-toggle" aria-label={t('expandFold')} onClick={() => setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                          return next;
                        })}>
                          <CaretDown size={14} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
                        </button>
                      ) : <span className="tree-toggle-placeholder" />}
                      {!hasKids ? (
                        <button className="tree-leaf" onClick={() => openMemory(row.memoryId)}>
                          {React.createElement(KIND_ICONS[row.kind] || Article, { size: 15 })}
                          <span>{row.title}</span>
                        </button>
                      ) : (
                        <span className="tree-folder" onClick={() => setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                          return next;
                        })}>
                          <strong>{row.title}</strong>
                          {open ? <small>{t('nItems', { n: row.kids || 0 })}</small> : null}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
              <div className="memory-list" role="table" aria-label={t('allMemories')}>
                <div className="memory-row memory-row-head" role="row" aria-hidden="true">
                  <span>{t('memoryType')}</span><span>{t('fieldTitle').replace(/\s*\(.*\)$/, '')}</span><span>{t('project')}</span><span>{t('updatedAt')}</span><span>{t('fieldTags').replace(/\s*\(.*\)$/, '')}</span><span />
                </div>
                {list.slice((listPage - 1) * PAGE_SIZE, listPage * PAGE_SIZE).map((m) => {
                  const tags = toTagList(m.tags);
                  const when = m.updated_at || m.created_at || '';
                  const whenText = when ? new Date(when).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { hour12: false }) : '—';
                  const KindIcon = KIND_ICONS[m.kind] || Article;
                  return (
                    <div className="memory-row" key={m.id} role="row">
                      <button className="memory-item" onClick={() => openMemory(m.id)}>
                        <span className="memory-cell cell-kind"><span className={`badge${m.importance === 'trivial' ? '' : ' purple'}`}>{kindLabel(m.kind) || t('memoryKind')}</span></span>
                        <span className="memory-cell cell-title"><KindIcon size={16} /><strong>{m.title || t('untitled')}</strong></span>
                        <span className="memory-cell cell-project">{m.project || '—'}</span>
                        <span className="memory-cell cell-updated">{whenText}</span>
                        <span className="memory-cell cell-tags">{tags.length ? tags.join(', ') : '—'}</span>
                        <CaretRight size={18} className="cell-arrow" />
                      </button>
                    </div>
                  );
                })}
                {!list.length && !emptyVault && <Empty title={t('noMemoryFound')} text={t('noMemoryHint')} />}
              </div>
              )}
              {!query && (viewMode === 'card' || viewMode === 'list') && list.length > PAGE_SIZE && (
                <Pager
                  total={list.length}
                  page={listPage}
                  onPage={setListPage}
                  labels={{ pager: t('pager'), prev: t('prevPage'), next: t('nextPage'), pageOf: t('pageOf', { n: '{n}', total: '{total}' }) }}
                />
              )}
            </section>
          </>
        )}
      </>
    );
  }

  if (page === 'sessions') {
    return (
      <>
        <Heading eyebrow="YOUR ACCOUNT / SESSIONS" title={t('sessionsTitle')} description={t('sessionsDesc')}>
          <Button primary icon={Plus} onClick={() => open({
            title: t('createNewSession'),
            icon: Desktop,
            fields: [{ name: 'name', label: t('deviceName'), placeholder: t('devicePh'), value: 'dashboard' }],
            onSubmit: async (v) => {
              const reply = await api('/api/self/sessions', { method: 'POST', token, body: { device_name: v.name || 'web' } });
              notify(t('sessionCreated'));
              onReload();
              open({
                title: t('saveSessionToken'),
                body: <SecretResult value={reply.token} notify={notify} description={t('tokenOnce')} />,
                submit: t('iSaved'),
              });
            },
            submit: t('mintToken'),
          })}>{t('createSession')}</Button>
        </Heading>
        <div className="session-summary">
          <div className="large-mark"><Desktop size={31} /></div>
          <div><h2>{t('nSessions', { n: sessions.length })}</h2><p>{t('sessionsLead')}</p></div>
          <Badge tone="green"><ShieldCheck size={16} />{t('connectionProtected')}</Badge>
        </div>
        <section className="panel">
          <div className="section-top"><h2>{t('connectedDevices')}</h2></div>
          {sessions.map((s) => {
            const I = /cli|terminal/i.test(s.device_name || '') ? Terminal : Desktop;
            return (
              <div className="session-row" key={s.id}>
                <span className="device-mark"><I size={28} /></span>
                <div><h3>{s.device_name}{s.current ? <Badge tone="purple">{t('currentSession')}</Badge> : null}</h3><p>{s.created_at}</p></div>
                <Button danger onClick={async () => {
                  await api(`/api/self/sessions/${s.id}/revoke`, { method: 'POST', token });
                  notify(t('sessionRevoked'));
                  if (s.current) onLogout();
                  else onReload();
                }}>{t('revoke')}</Button>
              </div>
            );
          })}
          {!sessions.length && <Empty title={t('noSessions')} text={t('noSessionsHint')} />}
        </section>
        <div className="setting-row plain">
          <div><h3>{t('rotateMain')}</h3><p>{t('rotateMainP')}</p></div>
          <Button icon={ArrowClockwise} onClick={async () => {
            const reply = await api('/api/self/rotate', { method: 'POST', token });
            onToken(reply.token);
            notify(t('rotated'));
            open({
              title: t('newMainToken'),
              body: <SecretResult value={reply.token} notify={notify} description={t('updateDevices')} />,
              submit: t('saved'),
            });
          }}>{t('rotateToken')}</Button>
        </div>
      </>
    );
  }

  const issueVault = async ({ reset }) => {
    // v4 recovery codes are generated rather than chosen by the user.
    const newSuper = generateSecretKey();
    const wrapped = await wrapVaultV4(newSuper);
    await api('/api/self/vault', { method: 'POST', token, body: wrapped });
    setTick((n) => n + 1);
    lockMemories();
    notify(reset ? t('keysResetLost') : t('superGenerated'));
    window.setTimeout(() => open({
      title: t('copySuperNowTitle'),
      body: <SecretResult value={newSuper} notify={notify} description={t('copySuperNowBody', { reset: reset ? t('copySuperNowReset') : '' })} />,
      submit: t('iCopied'),
    }), 0);
  };

  if (page === 'keys') {
    return (
      <>
        <Heading eyebrow="YOUR ACCOUNT / ENCRYPTION" title={t('keysTitle')} description={t('keysDesc')} />
        <div className="key-hero">
          <div className="large-mark"><Key size={35} /></div>
          <div>
            <h2>{t('keysHeroH2')}</h2>
            <p style={{ whiteSpace: 'pre-line' }}>{t('keysHeroP')}</p>
          </div>
          <Badge tone={hasVault ? 'green' : 'amber'}>{hasVault ? `Vault v${vaultInfo.version || 4}` : t('vaultNotSet')}</Badge>
        </div>
        {!hasVault && vaultInfo !== undefined ? (
          <Note icon={WarningCircle} tone="amber">{t('noWrap')}</Note>
        ) : null}
        <section className="panel key-panel">
          <div className="section-top"><h2>{t('memoryOnlyKeys')}</h2><Badge tone={keyStored ? 'green' : 'amber'}>{keyStored ? t('pageUnlocked') : t('pageLocked')}</Badge></div>
          <p>{t('memoryOnlyDescription')}</p>
          {legacyRecovery ? <>
            <Note tone="amber">{t('legacyRecoveryWarning')}</Note>
            <div className="key-actions">
              <Button icon={DownloadSimple} onClick={() => {
                try { download('respire-legacy-recovery.json', exportLegacyRecovery()); }
                catch (e) { notify(e.message); }
              }}>{t('legacyRecoveryExport')}</Button>
              <Button danger onClick={() => open({
                title: t('legacyRecoveryClear'), description: t('legacyRecoveryWarning'),
                fields: [{ name: 'confirm', label: t('legacyBackupConfirm'), options: [
                  { value: 'no', label: t('legacyBackupNotSaved') },
                  { value: 'yes', label: t('legacyBackupSaved') },
                ] }],
                validate: v => v.confirm === 'yes' ? null : t('legacyBackupNotSaved'),
                onSubmit: () => { clearLegacyRecovery(); setTick(n => n + 1); notify(t('legacyRecoveryCleared')); },
                submit: t('legacyRecoveryClear'), danger: true,
              })}>{t('legacyRecoveryClear')}</Button>
            </div>
          </> : null}
        </section>
        <div className="settings-stack">
          {!hasVault ? (
            <div className="setting-row">
              <div><h3>{t('genSuperH3')}</h3><p>{t('genSuperP')}</p></div>
              <Button primary onClick={async () => {
                try {
                  const pull = await api('/pull', { token });
                  if ((pull.total || 0) > 0) {
                    notify(t('cloudHasNoWrap', { n: pull.total }));
                    return;
                  }
                  await issueVault({ reset: false });
                } catch (e) { notify(e.message); }
              }}>{t('generateSuper')}</Button>
            </div>
          ) : (
            <div className="setting-row">
              <div><h3>{t('resetSuperH3')}</h3><p>{t('resetSuperP')}</p></div>
              <Button onClick={() => open({
                title: t('resetSuperTitle'),
                description: t('resetSuperDesc'),
                fields: [
                  { name: 'old', label: t('currentSuper'), type: 'password' },
                  ...(Number(vaultInfo?.version) === 3 ? [{ name: 'secret', label: 'Secret Key', type: 'password' }] : []),
                ],
                onSubmit: async (v) => {
                  const vault = await api('/api/self/vault', { token });
                  const urk = await unwrapUrk(v.old, v.secret, vault);
                  const newSuper = generateSecretKey();
                  let wrapped;
                  try { wrapped = await wrapVaultV4(newSuper, urk); }
                  finally { urk.fill(0); }
                  await api('/api/self/vault', { method: 'POST', token, body: wrapped });
                  setTick((n) => n + 1);
                  lockMemories();
                  window.setTimeout(() => open({
                    title: t('copyNewSuper'),
                    body: <SecretResult value={newSuper} notify={notify} description={t('oldSuperVoid')} />,
                    submit: t('iCopied'),
                  }), 0);
                  notify(t('superResetOk'));
                },
                submit: t('resetGen'),
              })}>{t('reset')}</Button>
            </div>
          )}
          {hasVault && Number(vaultInfo?.version) <= 3 ? (
            <div className="setting-row">
              <div><h3>{t('upgradeV4')}</h3><p>{t('upgradeV4P')}</p></div>
              <Badge tone="amber">v{vaultInfo?.version || 3}</Badge>
            </div>
          ) : null}
          {hasVault ? (
            <div className="setting-row">
              <div><h3>{t('resetKeysH3')}</h3><p>{t('resetKeysP')}</p></div>
              <Button danger onClick={() => open({
                title: t('resetKeysTitle'),
                description: t('resetKeysDesc'),
                danger: true,
                fields: [
                  { name: 'confirm', label: t('typeConfirmReset') },
                ],
                validate: (v) => (v.confirm !== t('confirmResetWord') ? t('pleaseTypeConfirmReset') : null),
                onSubmit: async (v) => { await issueVault({ reset: true }); },
                submit: t('confirmResetAbandon'),
              })}>{t('reset')}</Button>
            </div>
          ) : null}
          <div className="setting-row">
            <div><h3>{keyStored ? t('pageUnlocked') : t('pageLocked')}</h3><p>{t('memoryOnlyDescription')}</p></div>
            <Button danger={keyStored} onClick={() => keyStored ? lockMemories() : openUnlock()}>{keyStored ? t('lock') : t('unlockMemory')}</Button>
          </div>
        </div>
        <Note icon={WarningCircle} tone="amber">{t('keepSuperSafe')}</Note>
      </>
    );
  }

  return <Security admin={false} token={token} me={me} notify={notify} onReload={onReload} open={open} onLogout={onLogout} />;
}

/**
 * Render both single line breaks and blank-line paragraph separators in CLI content.
 * Preserve original line breaks and indentation within each paragraph.
 * Render bracketed section markers in separate blocks with a left border.
 */
function renderContent(content) {
  const raw = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return <p className="reading-empty">{t('emptyBody')}</p>;
  // CLI content may join bracketed section markers without line breaks.
  // Insert line breaks before section markers while preserving adjacent context.
  const text = raw.replace(/(?<![\n])(【[^】]{1,12}】)/g, '\n$1').trim();
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  return blocks.map((block, bi) => {
    const lines = block.split('\n').filter((l) => l.trim());
    const isMarked = lines.length > 1 && lines.some((l) => /^【.+?】/.test(l.trim()));
    if (isMarked) {
      return (
        <div className="reading-block is-marked" key={bi}>
          {lines.map((line, li) => {
            const m = line.trim().match(/^【(.+?)】\s*(.*)$/);
            if (m) return <p className="marked-line" key={li}><span className="marked-tag">{m[1]}</span><span>{m[2]}</span></p>;
            return <p className="plain-line" key={li}>{line}</p>;
          })}
        </div>
      );
    }
    if (lines.length === 1) return <p key={bi}>{lines[0]}</p>;
    return (
      <div className="reading-block" key={bi}>
        {lines.map((line, li) => <p className="plain-line" key={li}>{line}</p>)}
      </div>
    );
  });
}

/** Render tree branches on demand by loading children only for expanded nodes. */
function TreeRows({ index, parentId, depth, expanded, onToggle, onSelect, selected, onCount }) {
  // Compute child rows synchronously with useMemo when index or parentId changes.
  const rows = useMemo(() => childrenOf(index, parentId), [index, parentId]);
  return (rows || []).map((row) => {
    const isFolder = row.kind === 'folder' || row.kids > 0;
    const open = expanded.has(row.id);
    return (
      <div key={row.id}>
        <div className={`tree-row${selected === row.memoryId ? ' active' : ''}`} style={{ paddingLeft: 4 + depth * 16 }}>
          {isFolder ? (
            <button className="tree-toggle" aria-label={t('expandFold')} onClick={() => onToggle(row.id)}>
              <CaretDown size={14} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
            </button>
          ) : <span className="tree-toggle-placeholder" />}
          {!isFolder ? (
            <button className="tree-leaf" onClick={() => onSelect(row.memoryId)}>
              {React.createElement(KIND_ICONS[row.kind] || Article, { size: 15 })}
              <span>{row.title}</span>
            </button>
          ) : (
            <span className="tree-folder" onClick={() => onToggle(row.id)}>
              <strong>{row.title}</strong>
              {open ? <small>{row.id === DIARY_ID ? t('nDays', { n: row.kids }) : t('nItems', { n: (onCount ? onCount(row.id) : row.kids) || 0 })}</small> : null}
            </span>
          )}
        </div>
        {open ? (
          <TreeRows
            index={index}
            parentId={row.id}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onSelect={onSelect}
            selected={selected}
            onCount={onCount}
          />
        ) : null}
      </div>
    );
  });
}
