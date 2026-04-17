// String interpolation + plural form selection.
// - interpolate("Hi {name}", { name: "X" })  →  "Hi X"
// - getPluralForm("ru", 2)                   →  "few"

export function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? `{${key}}` : String(v);
  });
}

// Intl.PluralRules handles locale-specific plural form selection.
// Falls back to "other" if the locale is unknown.
const rulesCache = new Map();
function rulesFor(locale) {
  if (!rulesCache.has(locale)) {
    try {
      rulesCache.set(locale, new Intl.PluralRules(locale));
    } catch {
      rulesCache.set(locale, new Intl.PluralRules('en'));
    }
  }
  return rulesCache.get(locale);
}

export function getPluralForm(locale, count) {
  return rulesFor(locale).select(count);
}
