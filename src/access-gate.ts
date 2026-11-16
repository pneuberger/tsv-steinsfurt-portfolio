/**
 * Invite-link access gate (private site).
 *
 * Enabled only when the site is built with PUBLIC_ACCESS_GATE=true, which the staging
 * deploy script does (`npm run deploy:staging`). Production builds are unaffected:
 * no /admin/ and /kein-zugang/ pages, no extra privacy section.
 */
export const accessGate = import.meta.env.PUBLIC_ACCESS_GATE === 'true';

/** Default and maximum link validity offered in the committee form (days). */
export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 60;
