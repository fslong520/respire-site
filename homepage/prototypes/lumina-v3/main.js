'use strict';

const config = window.RESPIRE_CONFIG;
const I18n = window.RespireI18n;
const t = value => I18n.t(value);
const currentPrompt = () => window.RESPIRE_PROMPTS[I18n.language];
const installCommand = 'npm i -g @rsrsai/cli\npnpm add -g @rsrsai/cli';
document.getElementById('prompt-preview').textContent = currentPrompt();

let toastTimer;
function notify(message) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  toast.textContent = t(message);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

const dialogOpeners = new WeakMap();
function openDialog(dialog, trigger) {
  dialogOpeners.set(dialog, trigger || document.activeElement);
  dialog.showModal();
  document.body.classList.add('dialog-open');
}
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) document.body.classList.remove('dialog-open');
    dialogOpeners.get(dialog)?.focus();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
});
document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
});

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy === 'command' ? installCommand : currentPrompt();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      notify(button.dataset.copy === 'command' ? '安装命令已复制。' : '提示词已复制，粘贴给支持终端操作的 AI 即可。');
    } catch (error) {
      const field = document.getElementById('manual-copy');
      field.value = text;
      openDialog(document.getElementById('copy-dialog'), button);
      field.focus();
      field.select();
    }
  });
});
document.getElementById('select-copy').addEventListener('click', () => {
  const field = document.getElementById('manual-copy');
  field.focus();
  field.select();
});

const resourceNames = { github: 'GitHub', benchmark: 'Benchmark', docs: 'Docs' };
document.querySelectorAll('[data-resource]').forEach(link => {
  const key = link.dataset.resource;
  const url = config[key];
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  } else {
    link.addEventListener('click', event => {
      event.preventDefault();
      document.getElementById('resource-name').textContent = resourceNames[key];
      document.getElementById('resource-title').textContent = t('入口即将开放 {name}').replace('{name}', resourceNames[key]);
      document.getElementById('resource-description').textContent = key === 'benchmark'
        ? t('Benchmark 的公开地址将于后续提供。当前页面展示测试方向，尚未提供可访问的测试报告。')
        : t('公开地址将于后续提供。入口开放后，你可以从这里直接访问。');
      openDialog(document.getElementById('resource-dialog'), link);
    });
  }
});

function connectTabs(group, onSelect) {
  const tabs = [...group.querySelectorAll('[role="tab"]')];
  const activate = (tab, focus = false) => {
    tabs.forEach(item => {
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    });
    onSelect(tab);
    if (focus) tab.focus();
  };
  tabs.forEach(tab => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      if (event.isComposing) return;
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[index], true);
    });
  });
  return activate;
}

// Keep local-first, encryption and private repository access inside the original security module.
connectTabs(document.querySelector('.trust-tabs'), tab => {
  document.querySelectorAll('.trust-panel').forEach(panel => { panel.hidden = panel.id !== tab.dataset.trust; });
});

const menuToggle = document.querySelector('.mobile-toggle');
const mobileMenu = document.getElementById('mobile-navigation');
function closeMenu() {
  mobileMenu.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', t('打开菜单'));
}
menuToggle.addEventListener('click', () => {
  const open = mobileMenu.hidden;
  mobileMenu.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', t(open ? '关闭菜单' : '打开菜单'));
});
mobileMenu.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !mobileMenu.hidden) {
    closeMenu();
    menuToggle.focus();
  }
});
window.matchMedia('(min-width:851px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

// Reuse the current official interactive client preview, including its mode controls.
const frame = document.getElementById('client-preview');
const viewport = document.getElementById('client-viewport');
const previewHome = viewport.parentElement;
const previewDialog = document.getElementById('preview-dialog');
const modes = {
  Tree: ['记忆树', '从整棵树到一条记忆，背景、决定与经验都有来处。'],
  Sync: ['同步', '查看本地与云端状态，让记忆在设备之间保持一致。'],
  Install: ['接入 AI', '选择目标工具与记忆范围，把相关背景交给需要它的 AI。'],
};
let activeMode = 'Tree';
function resizePreview() {
  const width = viewport.clientWidth;
  const expanded = previewDialog.open;
  const compact = width < 680;
  const nativeWidth = expanded || compact ? width : 1440;
  const nativeHeight = expanded ? Math.max(320, Math.min(window.innerHeight - 142, 1050)) : compact ? 590 : 870;
  frame.style.width = `${nativeWidth}px`;
  frame.style.height = `${nativeHeight}px`;
  frame.style.transform = `scale(${width / nativeWidth})`;
  viewport.style.height = `${nativeHeight * width / nativeWidth}px`;
}
function selectClientMode(mode) {
  const buttons = frame.contentDocument?.querySelectorAll('.dock button');
  const target = [...(buttons || [])].find(button => button.textContent.trim() === mode);
  if (target) target.click();
}
function updateModeLabels(mode) {
  activeMode = mode;
  document.getElementById('preview-mode-label').textContent = t(modes[mode][0]);
  document.getElementById('preview-mode-description').textContent = t(modes[mode][1]);
  const tab = document.querySelector(`[data-mode="${mode}"]`);
  viewport.setAttribute('aria-labelledby', tab.id);
  document.querySelectorAll('[data-mode]').forEach(item => {
    item.setAttribute('aria-selected', String(item === tab));
    item.tabIndex = item === tab ? 0 : -1;
  });
}
connectTabs(document.querySelector('.mode-tabs'), tab => {
  updateModeLabels(tab.dataset.mode);
  selectClientMode(tab.dataset.mode);
});
frame.addEventListener('load', () => {
  resizePreview();
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener('click', event => {
    const button = event.target.closest('.dock button');
    const name = button?.textContent.trim();
    if (modes[name]) updateModeLabels(name);
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && previewDialog.open && !doc.querySelector('[role="dialog"]')) previewDialog.close();
  });
  // React can mount after the iframe load event. A bounded frame retry also
  // tolerates the transient about:blank document when moving the iframe.
  let attempts = 0;
  function restoreModeWhenReady() {
    if (frame.contentDocument !== doc) return;
    if (doc.querySelector('.dock button')) selectClientMode(activeMode);
    else if (++attempts < 120) requestAnimationFrame(restoreModeWhenReady);
  }
  restoreModeWhenReady();
});
new ResizeObserver(resizePreview).observe(viewport);
window.addEventListener('resize', resizePreview);
document.getElementById('expand-preview').addEventListener('click', event => {
  document.getElementById('expanded-slot').append(viewport);
  viewport.classList.add('expanded');
  openDialog(previewDialog, event.currentTarget);
  resizePreview();
});
previewDialog.addEventListener('close', () => {
  previewHome.append(viewport);
  viewport.classList.remove('expanded');
  resizePreview();
});
document.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', () => {
  updateModeLabels(button.dataset.preview);
  selectClientMode(button.dataset.preview);
  document.getElementById('product').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth' });
}));

const platformData = {
  mac: { title: 'Mac 客户端', help: '适用于 Apple 芯片（arm64）的 Mac。', options: [['Apple 芯片 · arm64 · .dmg', 'respire-macos-arm64.dmg']] },
  linux: { title: 'Linux 客户端', help: '按发行版和处理器架构选择安装包。', options: [
    ['Debian / Ubuntu · x64 · .deb', 'respire-linux-x64.deb'],
    ['Fedora / RHEL · x64 · .rpm', 'respire-linux-x64.rpm'],
    ['Debian / Ubuntu · ARM64 · .deb', 'respire-linux-arm64.deb'],
    ['Fedora / RHEL · ARM64 · .rpm', 'respire-linux-arm64.rpm'],
  ] },
};
const architecture = document.getElementById('architecture');
function updateDownload() { document.getElementById('download-link').href = config.downloadBase + architecture.value; }
let activePlatform = 'mac';
function renderPlatform(tab) {
  activePlatform = tab.dataset.platform;
  const data = platformData[activePlatform];
  document.getElementById('platform-content').setAttribute('aria-labelledby', tab.id);
  document.getElementById('platform-heading').textContent = t(data.title);
  document.getElementById('platform-help').textContent = t(data.help);
  architecture.replaceChildren(...data.options.map(([label, value]) => new Option(t(label), value)));
  document.getElementById('download-link').firstChild.textContent = t('下载 ' + data.title) + ' ';
  updateDownload();
}
connectTabs(document.querySelector('.platform-tabs'), renderPlatform);
architecture.addEventListener('change', updateDownload);

function refreshLanguage() {
  document.getElementById('prompt-preview').textContent = currentPrompt();
  updateModeLabels(activeMode);
  renderPlatform(document.querySelector(`[data-platform="${activePlatform}"]`));
  const previewLanguage = I18n.language === 'zh' ? 'zh' : 'en';
  const src = `preview/client.${previewLanguage}.html`;
  if (!window.RESPIRE_EMBEDDED_PREVIEWS && frame.getAttribute('src') !== src) frame.src = src;
  if (window.RESPIRE_EMBEDDED_PREVIEWS && frame.dataset.locale !== previewLanguage) {
    frame.dataset.locale = previewLanguage;
    frame.srcdoc = window.RESPIRE_EMBEDDED_PREVIEWS[previewLanguage];
  }
  const note = t('可点击体验的客户端设计预览，展示内容为示例记忆。');
  document.querySelector('.preview-note').textContent = note + (!['en','zh'].includes(I18n.language) ? ' ' + t('当前客户端预览使用英文示例。') : '');
}
window.addEventListener('languagechange', refreshLanguage);
refreshLanguage();
