import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ArrowDown, ArrowsClockwise, BookOpen, CaretDown, Check, CheckCircle, CloudCheck, Code, Copy, DownloadSimple, Eye, Folder, GithubLogo, Laptop, List, LockKey, Monitor, PlugsConnected, ShieldCheck, TreeStructure, X, CornersOut, TerminalWindow, AppleLogo } from '@phosphor-icons/react';
import logo from '../public/brand/logo.svg?inline';
import { DEFAULT_LOCALE, dictFor, localeFromPath, prefersLocale } from './i18n/index.js';

const REPOSITORY = 'https://github.com/risense-ai/respire-cli';
const RELEASE_CHANNEL = 'https://github.com/risense-ai/respire-releases/releases';
const DOCS = 'https://github.com/risense-ai/respire-docs';
const DASHBOARD = 'https://dash.rsrs.rs'; // Configured destination; live availability is not asserted.
const INSTALL = 'npm i -g @rsrsai/cli\npnpm add -g @rsrsai/cli';

// Select the language from the initial URL prefix.
const LOCALE = localeFromPath(typeof window === 'undefined' ? '/' : window.location.pathname);
const { t } = dictFor(LOCALE);

const modes = [
  { id: 'Tree', name: t('mode.tree.name'), icon: TreeStructure, description: t('mode.tree.description') },
  { id: 'Sync', name: t('mode.sync.name'), icon: ArrowsClockwise, description: t('mode.sync.description') },
  { id: 'Install', name: t('mode.install.name'), icon: PlugsConnected, description: t('mode.install.description') },
];
const PREVIEW_SRC = `/preview/client.${LOCALE}.html`;

// The same-origin preview is a standalone bundle.
// Parent tab changes click the matching dock button in the iframe.
// Dock clicks update parent state in both supported languages.
//
// The preview has no postMessage listener; use its same-origin DOM.
// The bridge leaves the standalone preview unchanged.
function usePreviewBridge(frame, onMode) {
  const detach = useRef(null);
  useEffect(() => () => detach.current?.(), []);
  return () => {
    detach.current?.();
    detach.current = attachBridge(frame, onMode);
  };
}

/// Attach the bridge after load and return a listener cleanup function.
function attachBridge(frame, onMode) {
  const doc = frame.current?.contentDocument;
  if (!doc) return null;
  const click = event => {
    const button = event.target.closest?.('.dock button');
    if (button) onMode(button.textContent.trim());
  };
  doc.addEventListener('click', click);
  return () => doc.removeEventListener('click', click);
}

/// Synchronize the parent tab by clicking the matching preview dock button.
function syncPreviewMode(frame, mode) {
  const doc = frame.current?.contentDocument;
  const button = Array.from(doc?.querySelectorAll('.dock button') ?? []).find(b => b.textContent.trim() === mode);
  button?.click();
}

function ClientPreview({ mode, onMode, expanded = false }) {
  const box = useRef(null);
  const frame = useRef(null);
  const bridge = usePreviewBridge(frame, onMode);
  const [width, setWidth] = useState(1200);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    syncPreviewMode(frame, mode);
  }, [mode]);
  const narrow = width < 680;
  const canvasWidth = expanded || narrow ? width : 1440;
  const canvasHeight = expanded ? Math.min(window.innerHeight - 142, 1050) : narrow ? 590 : 870;
  const scale = width / canvasWidth;
  return <div ref={box} className={`client-viewport ${expanded ? 'expanded' : ''}`} style={{ height: canvasHeight * scale }}>
    <iframe ref={frame} title={t('a11y.previewFrame')} src={PREVIEW_SRC} onLoad={() => { bridge(); syncPreviewMode(frame, mode); }} style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${scale})` }} />
  </div>;
}

function LanguageSwitch() {
  return <a className="lang-switch" href={t('lang.otherHref')} lang={LOCALE === 'zh' ? 'en' : 'zh-CN'} aria-label={`${t('lang.switch')}: ${t('lang.other')}`}>{t('lang.other')}</a>;
}

function App() {
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState('Tree');
  const [expanded, setExpanded] = useState(false);
  const [platform, setPlatform] = useState('macOS');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [langHint, setLangHint] = useState(false);
  const dialog = useRef(null);
  const copyTimer = useRef(null);
  useEffect(() => {
    const agent = navigator.userAgent;
    setPlatform(agent.includes('Linux') ? 'Linux' : 'macOS');
    return () => clearTimeout(copyTimer.current);
  }, []);
  useEffect(() => {
    // Offer a language hint once without redirecting the visitor.
    if (LOCALE !== DEFAULT_LOCALE || !prefersLocale('zh')) return;
    try {
      if (sessionStorage.getItem('respire-lang-hint') === 'dismissed') return;
    } catch { /* Show the hint when browser privacy settings disable sessionStorage. */ }
    setLangHint(true);
  }, []);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);
  useEffect(() => {
    const close = event => { if (event.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  const dismissLangHint = () => {
    try { sessionStorage.setItem('respire-lang-hint', 'dismissed'); } catch { /* Ignore unavailable sessionStorage for this optional hint. */ }
    setLangHint(false);
  };
  const tryMode = page => {
    setMode(page);
    document.getElementById('product').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(t('download.prompt'));
      setPromptCopied(true); setCopied(false); setCopyError(false);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setPromptCopied(false), 2500);
    } catch {
      setCopyError(true);
    }
  };
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true); setPromptCopied(false); setCopyError(false);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopyError(true);
    }
  };
  const nav = [[t('nav.product'), '#product'], [t('nav.how'), '#how'], [t('nav.security'), '#security'], [t('nav.faq'), '#faq']];
  const platformInfo = {
    macOS: [t('platform.macOS.title'), t('platform.macOS.help'), AppleLogo],
    Linux: [t('platform.Linux.title'), t('platform.Linux.help'), TerminalWindow],
  };
  const platformDownloads = {
    macOS: [
      { id: 'arm64', label: t('arch.mac.desktop'), file: 'respire-macos-arm64.dmg' },
      { id: 'cli-arm64', label: t('arch.mac.cli'), file: 'rsrs-aarch64-apple-darwin' },
    ],
    Linux: [
      { id: 'x64-deb', label: t('arch.linux.deb.x64'), file: 'respire-linux-x64.deb' },
      { id: 'x64-rpm', label: t('arch.linux.rpm.x64'), file: 'respire-linux-x64.rpm' },
      { id: 'arm64-deb', label: t('arch.linux.deb.arm64'), file: 'respire-linux-arm64.deb' },
      { id: 'arm64-rpm', label: t('arch.linux.rpm.arm64'), file: 'respire-linux-arm64.rpm' },
      { id: 'cli-x64', label: t('arch.linux.cli.x64'), file: 'rsrs-x86_64-unknown-linux-gnu' },
      { id: 'cli-arm64', label: t('arch.linux.cli.arm64'), file: 'rsrs-aarch64-unknown-linux-gnu' },
    ],
  };
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const linuxRpm = /Fedora|Red Hat|CentOS|Rocky|Alma/i.test(ua);
  const recommendedArch = platform === 'macOS'
    ? 'arm64'
    : `${/aarch64|arm64/i.test(ua) ? 'arm64' : 'x64'}-${linuxRpm ? 'rpm' : 'deb'}`;
  const PlatformIcon = platformInfo[platform][2];
  const RELEASES = RELEASE_CHANNEL;

  return <>
    <a className="skip-link" href="#main">{t('a11y.skipToMain')}</a>
    {langHint && <div className="lang-hint" role="status"><span>{t('lang.suggest')}</span><a href={t('lang.otherHref')}>{t('lang.suggestAction')}</a><button type="button" onClick={dismissLangHint} aria-label={t('lang.suggestDismiss')}><X size={16} /></button></div>}
    <header className="site-header">
      <nav className="nav-container" aria-label={t('a11y.mainNav')}>
        <a className="brand" href="#top" aria-label={t('a11y.home')}><img src={logo} alt="Respire" /></a>
        <div className="nav-links">{nav.map(([name, href]) => <a href={href} key={href}>{name}</a>)}</div>
        <div className="nav-actions"><a className="github-link" href={REPOSITORY} target="_blank" rel="noreferrer" aria-label={t('a11y.github')}><GithubLogo size={21} /></a><LanguageSwitch /><a className="login-link" href={DASHBOARD}>{t('nav.login')}</a><a className="button primary small" href="#download">{t('nav.download')}<ArrowDown size={16} /></a></div>
        <button className="mobile-toggle" aria-expanded={menu} aria-controls="mobile-navigation" aria-label={menu ? t('a11y.closeMenu') : t('a11y.openMenu')} onClick={() => setMenu(!menu)}>{menu ? <X size={24} /> : <List size={24} />}</button>
      </nav>
      {menu && <nav id="mobile-navigation" className="mobile-navigation" aria-label={t('a11y.mobileNav')}>{nav.map(([name, href]) => <a key={href} href={href} onClick={() => setMenu(false)}>{name}<ArrowUpRight size={17} /></a>)}<a href={DASHBOARD}>{t('nav.loginDashboard')}<ArrowUpRight size={17} /></a><a href="#download" onClick={() => setMenu(false)}>{t('nav.download')}<DownloadSimple size={17} /></a><a href={t('lang.otherHref')} onClick={() => setMenu(false)}>{t('lang.other')}<ArrowUpRight size={17} /></a></nav>}
    </header>

    <main id="main">
      <section className="hero container" id="top">
        <a className="announcement" href="#product"><span className="status-dot" />{t('hero.announcement')}<ArrowUpRight size={14} /></a>
        <h1>{t('hero.titleLead')}<br /><span>{t('hero.titleTail')}</span></h1>
        <p className="hero-description">{t('hero.descriptionLead')}<br className="desktop-break" />{t('hero.descriptionTail')}</p>
        <div className="hero-actions"><button className="button primary" aria-label={t('a11y.copyPrompt')} onClick={copyPrompt}>{promptCopied ? <Check size={21} /> : <Copy size={21} />}{promptCopied ? t('hero.downloadDone') : t('hero.download')}</button><a className="button ghost" href="#manual">{t('hero.try')}<ArrowDown size={18} /></a></div>
        <div className="hero-principles"><span><Laptop size={17} />{t('hero.local')}</span><span><ShieldCheck size={17} />{t('hero.e2ee')}</span><span><TreeStructure size={17} />{t('hero.scoped')}</span></div>
      </section>

      <section className="product-section container" id="product" aria-label={t('a11y.productPreview')}>
        <div className="preview-heading"><div className="preview-breadcrumb"><span className="status-dot" /><span>{t('preview.brand')}</span><span className="muted">/</span><strong>{mode === 'Tree' ? t('preview.mode.tree') : mode === 'Sync' ? t('preview.mode.sync') : t('preview.mode.install')}</strong></div><button className="expand-control" onClick={() => setExpanded(true)}><CornersOut size={17} /><span>{t('preview.expand')}</span></button></div>
        <div className="client-frame"><ClientPreview mode={mode} onMode={setMode} /></div>
        <div className="preview-controls"><div className="mode-tabs" role="tablist" aria-label={t('a11y.previewTabs')}>{modes.map(({ id, name, icon: Icon }) => <button key={id} role="tab" aria-selected={mode === id} onClick={() => setMode(id)}><Icon size={20} /><span>{id}</span><small>{name}</small></button>)}</div><p>{modes.find(m => m.id === mode).description}</p></div>
        <p className="preview-note">{t('preview.note')}</p>
      </section>

      <section className="intro-section container" aria-labelledby="intro-title">
        <div className="section-index"><span>{t('intro.index')}</span> {t('intro.kicker')}</div>
        <div className="intro-grid"><h2 id="intro-title">{t('intro.titleLead')}<br /><span className="subtle">{t('intro.titleTail')}</span></h2><div><p>{t('intro.p1')}</p><p>{t('intro.p2')}</p></div></div>
        <div className="value-grid">
          <article><div className="feature-icon lavender"><TreeStructure size={28} /></div><h3>{t('intro.card1.title')}</h3><p>{t('intro.card1.body')}</p><button className="text-button" onClick={() => tryMode('Tree')}>{t('intro.card1.action')}<ArrowUpRight size={17} /></button></article>
          <article><div className="feature-icon sage"><ArrowsClockwise size={28} /></div><h3>{t('intro.card2.title')}</h3><p>{t('intro.card2.body')}</p><button className="text-button" onClick={() => tryMode('Sync')}>{t('intro.card2.action')}<ArrowUpRight size={17} /></button></article>
          <article><div className="feature-icon sand"><PlugsConnected size={28} /></div><h3>{t('intro.card3.title')}</h3><p>{t('intro.card3.body')}</p><button className="text-button" onClick={() => tryMode('Install')}>{t('intro.card3.action')}<ArrowUpRight size={17} /></button></article>
        </div>
      </section>

      <section className="workflow-section container" id="how">
        <div className="section-index"><span>{t('how.index')}</span> {t('how.kicker')}</div>
        <div className="section-heading"><h2>{t('how.titleLead')}<br /><span className="subtle">{t('how.titleTail')}</span></h2><p>{t('how.leadLead')}<br />{t('how.leadTail')}</p></div>
        <div className="workflow-list">
          <article><span className="step-number">01</span><div className="step-title"><TreeStructure size={25} /><h3>{t('how.step1.title')}</h3><span>Memory Tree</span></div><p>{t('how.step1.body')}</p><button aria-label={t('how.step1.action')} onClick={() => tryMode('Tree')}><ArrowUpRight size={23} /></button></article>
          <article><span className="step-number">02</span><div className="step-title"><CloudCheck size={25} /><h3>{t('how.step2.title')}</h3><span>Sync</span></div><p>{t('how.step2.body')}</p><button aria-label={t('how.step2.action')} onClick={() => tryMode('Sync')}><ArrowUpRight size={23} /></button></article>
          <article><span className="step-number">03</span><div className="step-title"><PlugsConnected size={25} /><h3>{t('how.step3.title')}</h3><span>Install</span></div><p>{t('how.step3.body')}</p><button aria-label={t('how.step3.action')} onClick={() => tryMode('Install')}><ArrowUpRight size={23} /></button></article>
        </div>
        <a className="documentation-link" href={DOCS} target="_blank" rel="noreferrer"><BookOpen size={20} /><span>{t('how.docs')}</span><ArrowUpRight size={18} /></a>
      </section>

      <section className="security-section container" id="security">
        <div className="security-card">
          <div className="security-copy"><div className="section-index"><ShieldCheck size={19} /> {t('security.kicker')}</div><h2>{t('security.titleLead')}<br /><span className="subtle">{t('security.titleTail')}</span></h2><p>{t('security.bodyLead')}<br />{t('security.bodyTail')}</p><a className="text-button" href={DOCS} target="_blank" rel="noreferrer">{t('security.link')}<ArrowUpRight size={18} /></a></div>
          <div className="privacy-facts"><div><span className="feature-icon"><Laptop size={25} /></span><section><h3>{t('security.fact1.title')}</h3><p>{t('security.fact1.body')}</p></section></div><div><span className="feature-icon"><LockKey size={25} /></span><section><h3>{t('security.fact2.title')}</h3><p>{t('security.fact2.body')}</p></section></div><div><span className="feature-icon"><Folder size={25} /></span><section><h3>{t('security.fact3.title')}</h3><p>{t('security.fact3.body')}</p></section></div></div>
        </div>
      </section>

      <section className="faq-section container" id="faq"><div><div className="section-index"><span>{t('faq.index')}</span> {t('faq.kicker')}</div><h2>{t('faq.title')}</h2><p>{t('faq.leadLead')}<br />{t('faq.leadMid')}<a href={DOCS} target="_blank" rel="noreferrer">{t('faq.leadDocs')}<ArrowUpRight size={14} /></a>{t('faq.leadTail')}</p></div><div className="faq-list">
        {[
          [t('faq.q1'), t('faq.a1')],
          [t('faq.q2'), t('faq.a2')],
          [t('faq.q3'), t('faq.a3')],
          [t('faq.q4'), t('faq.a4')],
          [t('faq.q5'), t('faq.a5')],
        ].map(([q, a], i) => <details key={q} open={i === 0}><summary>{q}<CaretDown size={20} /></summary><p>{a}</p></details>)}
      </div></section>

      <section className="download-section container" id="download"><div className="download-copy"><div className="section-index"><span className="status-dot" /> {t('download.kicker')}</div><h2>{t('download.titleLead')}<br /><span className="subtle">{t('download.titleTail')}</span></h2><p>{t('download.bodyLead')}<br />{t('download.bodyTail')}</p><div className="download-links"><a href={DASHBOARD}>{t('download.dashboard')}<ArrowUpRight size={17} /></a><a href={DOCS} target="_blank" rel="noreferrer">{t('download.guide')}<ArrowUpRight size={17} /></a></div></div><div className="ai-panel"><div className="ai-panel-head"><TerminalWindow size={17} /><strong>{t('download.promptTitle')}</strong><span className="muted">{t('download.promptTools')}</span></div><pre className="ai-prompt-body">{t('download.prompt')}</pre><div className="ai-panel-foot"><button className="button primary small" aria-label={t('a11y.copyPrompt')} onClick={copyPrompt}>{promptCopied ? <Check size={18} /> : <Copy size={18} />}{promptCopied ? t('download.promptCopied') : t('download.copyPrompt')}</button><span role="status">{copyError ? t('download.copyDenied') : t('download.promptHint')}</span></div></div></section>

      <section className="download-section manual-section container" id="manual"><div className="download-copy"><div className="section-index"><span>{t('download.manualKicker')}</span></div><h2>{t('download.manualTitleLead')}<br /><span className="subtle">{t('download.manualTitleTail')}</span></h2><p>{t('download.manualBodyLead')}<br />{t('download.manualBodyTail')}</p></div><div className="download-panel"><div className="platform-tabs" role="tablist" aria-label={t('a11y.chooseOS')}>{['macOS', 'Linux'].map(p => <button key={p} role="tab" aria-selected={p === platform} onClick={() => setPlatform(p)}>{p}</button>)}</div><div className="platform-heading"><div className="feature-icon"><PlatformIcon size={33} /></div><div><h3>{platformInfo[platform][0]}</h3><p>{t('download.desktop')}</p></div></div><p className="platform-help">{platformInfo[platform][1]}</p><div className="download-archs">{platformDownloads[platform].map(item => <a key={item.id} className={`button download-button ${item.id === recommendedArch ? 'primary' : ''}`} href={RELEASES}><DownloadSimple size={20} />{item.label}{item.id === recommendedArch ? t('download.recommended') : ''}<ArrowUpRight size={17} /></a>)}</div><p className="release-note">{t('download.releaseNoteLead')}<a href={RELEASES} target="_blank" rel="noreferrer">{t('download.releaseNoteLink')}</a>{t('download.releaseNoteTail')}</p><div className="cli-block"><div><TerminalWindow size={17} /><strong>{t('download.cliTitle')}</strong><a href={REPOSITORY} target="_blank" rel="noreferrer">{t('download.cliDocs')}<ArrowUpRight size={13} /></a></div><div className="command-line"><code>{INSTALL}</code><button aria-label={t('a11y.copyInstall')} onClick={copyCommand}>{copied ? <Check size={18} /> : <Copy size={18} />}</button></div><p role="status">{copyError ? t('download.copyDenied') : copied ? t('download.copied') : t('download.copyHint')}</p></div></div></section>
    </main>
    <footer className="footer container"><div className="footer-top"><a className="brand" href="#top" aria-label={t('a11y.backHome')}><img src={logo} alt="Respire" /></a><p>{t('footer.tagline')}</p><div><a href={DOCS} target="_blank" rel="noreferrer">{t('footer.docs')}</a><a href={REPOSITORY} target="_blank" rel="noreferrer">GitHub</a><a href={DASHBOARD}>{t('footer.dashboard')}</a></div></div><div className="footer-bottom"><span>{t('footer.copyright')}</span><span>{t('footer.summary')}</span><a href="#top">{t('footer.backToTop')}<ArrowUpRight size={15} /></a></div></footer>
    <dialog ref={dialog} aria-label={t('a11y.expandPreview')} className="preview-dialog" onCancel={() => setExpanded(false)} onClick={e => { if (e.target === dialog.current) setExpanded(false); }}><div className="dialog-heading"><img src={logo} alt="Respire" /><span>{t('preview.demoTitle')}</span><button onClick={() => setExpanded(false)} aria-label={t('a11y.closeFullscreen')}><X size={22} /></button></div>{expanded && <ClientPreview mode={mode} onMode={setMode} expanded />}</dialog>
  </>;
}

export default App;
