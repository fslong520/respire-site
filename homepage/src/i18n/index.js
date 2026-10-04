// Resolve English at / and Chinese at /zh/.
//
// The default language has no prefix; other languages use their locale prefix.
// The server selects the localized entry and the client reads location.pathname.
// Both sides must use the same language routing policy.
import zh from './zh.js';
import en from './en.js';

export const DEFAULT_LOCALE = 'en';
export const LOCALES = ['en', 'zh'];

const DICTS = { en, zh };

/// Map a language to its URL prefix; the default prefix is empty.
export function localePrefix(locale) {
  return locale === DEFAULT_LOCALE ? '' : `/${locale}/`;
}

/// Resolve a URL prefix, using the default language for unknown prefixes.
export function localeFromPath(pathname) {
  const seg = String(pathname || '/').split('/').filter(Boolean)[0];
  return LOCALES.includes(seg) ? seg : DEFAULT_LOCALE;
}

/// Resolve translation keys with a default-language fallback.
export function dictFor(locale) {
  const dict = DICTS[locale] ?? DICTS[DEFAULT_LOCALE];
  return {
    t: (key) => dict[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key,
    locale,
  };
}

/// Return the root path for the alternate supported language.
export function alternateHref(locale, pathname) {
  const other = locale === 'zh' ? 'en' : 'zh';
  const prefix = localePrefix(other);
  return prefix || '/';
}

/// Check browser language preferences for the optional hint.
export function prefersLocale(locale) {
  if (typeof navigator === 'undefined') return false;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => String(l || '').toLowerCase().startsWith(locale));
}
