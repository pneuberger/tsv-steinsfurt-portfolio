import de from './de.json';
import en from './en.json';

/**
 * To add a language:
 *  1. create `src/i18n/<code>.json` with the same structure as `de.json`
 *  2. register it below
 *  3. add the code to `i18n.locales` in astro.config.mjs
 *  4. add `src/pages/<code>/index.astro` (copy of `src/pages/en/index.astro`)
 */
// `satisfies` makes TypeScript flag any language file that is missing keys from de.json.
export const dictionaries = { de, en } satisfies Record<string, typeof de>;

export type Lang = keyof typeof dictionaries;
export type Dictionary = typeof de;

export const defaultLang: Lang = 'de';
export const languages = Object.keys(dictionaries) as Lang[];

/** Full, typed dictionary for one language. */
export function useTranslations(lang: Lang): Dictionary {
  return dictionaries[lang] as Dictionary;
}

/** URL path of the one-pager for a language: "/" for German, "/en/" etc. otherwise. */
export function pathFor(lang: Lang): string {
  return lang === defaultLang ? '/' : `/${lang}/`;
}
