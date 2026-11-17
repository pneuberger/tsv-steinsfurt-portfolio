/**
 * Invite-link access gate (private site).
 *
 * Enabled only when the site is built with PUBLIC_ACCESS_GATE=true, which the staging
 * deploy script does (`npm run deploy:staging`). Production builds are unaffected:
 * no /admin/ and /no-access/ pages, no extra privacy section.
 */
export const accessGate = import.meta.env.PUBLIC_ACCESS_GATE === 'true';

/** Link validity offered in the committee form (hours). The API accepts only these values. */
export const VALIDITY_HOURS = [24, 48];
export const DEFAULT_HOURS = 24;
