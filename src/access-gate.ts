/**
 * Invite-link access gate (private site).
 *
 * Enabled when the site is built with PUBLIC_ACCESS_GATE=true (GitHub pipeline for production,
 * `npm run deploy:staging` for staging). Without it: no /admin/ and /no-access/ pages,
 * no greeting, no extra privacy section.
 */
export const accessGate = import.meta.env.PUBLIC_ACCESS_GATE === 'true';

/** Link validity offered in the committee form (hours). The API accepts only these values. */
export const VALIDITY_HOURS = [24, 48];
export const DEFAULT_HOURS = 24;
