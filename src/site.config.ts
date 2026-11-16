/**
 * Site-wide switches.
 *
 * `indexable`: keep `false` while the site still shows placeholder content
 * (invented quotes, dummy phone numbers, draft legal texts). Every page then
 * carries `<meta name="robots" content="noindex, nofollow">`, so search engines
 * don't list it. Set to `true` on launch day (see README → "Going live").
 */
export const indexable = false;
