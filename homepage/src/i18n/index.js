// 官网语言解析：默认英文（/），中文在 /zh/。
//
// URL 策略：默认语言不带前缀，其余语言带前缀。这样英文站在根路径，中文站在
// /zh/。服务端（service/src/server.rs）按前缀返回对应产物，前端按 location.pathname
// 选定词条集，两处必须一致。
import zh from './zh.js';
import en from './en.js';

export const DEFAULT_LOCALE = 'en';
export const LOCALES = ['en', 'zh'];

const DICTS = { en, zh };

/// 语言 → 站点路径前缀（默认语言为空串）。
export function localePrefix(locale) {
  return locale === DEFAULT_LOCALE ? '' : `/${locale}/`;
}

/// 站点路径前缀 → 语言（无法识别时回落默认语言）。
export function localeFromPath(pathname) {
  const seg = String(pathname || '/').split('/').filter(Boolean)[0];
  return LOCALES.includes(seg) ? seg : DEFAULT_LOCALE;
}

/// 取当前语言词条集；缺失键回落默认语言，仍缺则回显键名（便于发现漏译）。
export function dictFor(locale) {
  const dict = DICTS[locale] ?? DICTS[DEFAULT_LOCALE];
  return {
    t: (key) => dict[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key,
    locale,
  };
}

/// 当前路径对应的另一语言站点路径（保留锚点与查询串之外的部分）。
export function alternateHref(locale, pathname) {
  const other = locale === 'zh' ? 'en' : 'zh';
  const prefix = localePrefix(other);
  return prefix || '/';
}

/// 浏览器偏好是否更接近某语言（用于英文站上的中文提示，不做强制跳转）。
export function prefersLocale(locale) {
  if (typeof navigator === 'undefined') return false;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => String(l || '').toLowerCase().startsWith(locale));
}
