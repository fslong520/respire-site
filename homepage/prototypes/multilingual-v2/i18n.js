'use strict';
(() => {
  const supported = ['en', 'zh', 'es', 'fr', 'ko', 'ja'];
  const catalog = window.RESPIRE_TRANSLATIONS;
  const aliases = new Map();
  Object.entries(catalog).forEach(([key, values]) => {
    aliases.set(key, key);
    Object.values(values).forEach(value => aliases.set(value, key));
  });
  let language = supported.includes(new URL(location.href).searchParams.get('lang')) ? new URL(location.href).searchParams.get('lang') : 'en';
  function t(value) {
    const key = aliases.get(value) || value;
    return catalog[key]?.[language] || value;
  }
  function translatePage() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      if (node.parentElement?.closest('script,style,textarea,[data-language-names]')) return;
      const value = node.textContent.trim();
      if (!aliases.has(value)) return;
      const leading = node.textContent.match(/^\s*/)[0];
      const trailing = node.textContent.match(/\s*$/)[0];
      node.textContent = leading + t(value) + trailing;
    });
    document.querySelectorAll('[aria-label],[title],[alt]').forEach(element => {
      ['aria-label', 'title', 'alt'].forEach(attr => {
        if (element.hasAttribute(attr)) element.setAttribute(attr, t(element.getAttribute(attr)));
      });
    });
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    document.title = t('respire — 换 AI，不换记忆。');
    document.querySelector('meta[name="description"]').content = t('respire 是独立于 Agent 的个人记忆层。');
    document.getElementById('language-select').value = language;
  }
  function setLanguage(next, updateURL = true) {
    if (!supported.includes(next)) return;
    language = next;
    translatePage();
    if (updateURL) {
      const url = new URL(location.href);
      if (language === 'en') url.searchParams.delete('lang');
      else url.searchParams.set('lang', language);
      history.replaceState(null, '', url);
    }
    window.dispatchEvent(new CustomEvent('languagechange', { detail: language }));
  }
  window.RespireI18n = { t, setLanguage, get language() { return language; } };
  document.getElementById('language-select').addEventListener('change', event => setLanguage(event.target.value));
  setLanguage(language, false);
})();
