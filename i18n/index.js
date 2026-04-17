// Minimal vanilla-JS i18n.
//
// Public API:
//   t(key, vars?)                  → string
//   tPlural(baseKey, count, vars?) → string (picks key + "_" + pluralForm)
//   getLocale()                    → "en" | "ru" | "es"
//   setLocale(locale)              → void (persists to localStorage, fires change event)
//   onLocaleChange(fn)             → unsubscribe()
//   statusKey(status)              → translation key for a state-machine status
//
// Adding a new locale:
//   1. Create translations/<locale>.js with the same keys as en.js.
//   2. Add it to ALL_LOCALES / LOCALE_LABELS / TRANSLATIONS below.
//   3. If it needs a plural rule not covered by Intl.PluralRules, patch
//      interpolate.js (rare — browsers already know most locales).

import en from './translations/en.js';
import ru from './translations/ru.js';
import es from './translations/es.js';
import { interpolate, getPluralForm } from './interpolate.js';

export const ALL_LOCALES = ['en', 'ru', 'es'];
export const LOCALE_LABELS = { en: 'English', ru: 'Русский', es: 'Español' };
const TRANSLATIONS = { en, ru, es };
const STORAGE_KEY = 'gymkhana-locale';

const listeners = new Set();

function detectDefault() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && ALL_LOCALES.includes(saved)) return saved;
  const browser = (navigator.language || 'en').slice(0, 2);
  return ALL_LOCALES.includes(browser) ? browser : 'en';
}

let currentLocale = detectDefault();

export function getLocale() {
  return currentLocale;
}

export function setLocale(locale) {
  if (!ALL_LOCALES.includes(locale)) return;
  if (locale === currentLocale) return;
  currentLocale = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  for (const fn of listeners) fn(locale);
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(locale, key) {
  const table = TRANSLATIONS[locale];
  if (table && key in table) return table[key];
  // Fall back to English, then the key itself so missing strings are visible.
  if (locale !== 'en' && key in TRANSLATIONS.en) return TRANSLATIONS.en[key];
  return key;
}

export function t(key, vars) {
  return interpolate(lookup(currentLocale, key), vars);
}

export function tPlural(baseKey, count, vars) {
  const form = getPluralForm(currentLocale, count);
  const key = `${baseKey}_${form}`;
  const table = TRANSLATIONS[currentLocale];
  const resolved = table && key in table ? key : `${baseKey}_other`;
  return interpolate(lookup(currentLocale, resolved), { count, ...vars });
}

export function statusKey(status) {
  switch (status) {
    case 'IDLE': return 'status.idle';
    case 'WAITING_START': return 'status.waitingStart';
    case 'RUNNING': return 'status.running';
    case 'FINISHED': return 'status.finished';
    default: return 'status.idle';
  }
}
