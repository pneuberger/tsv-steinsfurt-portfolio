// @ts-check
import { defineConfig } from 'astro/config';

/**
 * Invite-link pages (/admin/, /no-access/, /en/no-access/) exist only in the staging build
 * (PUBLIC_ACCESS_GATE=true, set by `npm run deploy:staging`). They live in src/gate-pages/
 * instead of src/pages/, so production builds contain neither the pages nor their scripts/CSS.
 * @type {import('astro').AstroIntegration}
 */
const gatePages = {
  name: 'gate-pages',
  hooks: {
    'astro:config:setup': ({ injectRoute }) => {
      if (process.env.PUBLIC_ACCESS_GATE !== 'true') return;
      injectRoute({ pattern: '/admin', entrypoint: './src/gate-pages/admin.astro' });
      injectRoute({ pattern: '/no-access', entrypoint: './src/gate-pages/no-access.de.astro' });
      injectRoute({ pattern: '/en/no-access', entrypoint: './src/gate-pages/no-access.en.astro' });
    },
  },
};

// https://astro.build/config
export default defineConfig({
  integrations: [gatePages],
  // Public address of the site (used for canonical/hreflang/OG URLs).
  // For now the CloudFront URL; switch to the custom domain once one is set up.
  // The site is independent of the club homepage (tsvphoenixsteinsfurt.de).
  // SITE_URL overrides it for other environments (staging deploy script).
  site: process.env.SITE_URL || 'https://d384ezf8yukgl8.cloudfront.net',
  trailingSlash: 'ignore',
  build: {
    // /en/ -> dist/en/index.html (the CloudFront Function maps /en/ to it)
    format: 'directory',
  },
  security: {
    // Content-Security-Policy as <meta> tag. Astro adds sha256 hashes for its own
    // scripts/styles to script-src/style-src on every build. Only same-origin content
    // is allowed; the site loads nothing from third parties.
    // (frame-ancestors can't be set via <meta>; clickjacking is covered by the
    // X-Frame-Options: DENY header from CloudFront.)
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self'",
        "media-src 'self'",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
        'upgrade-insecure-requests',
      ],
    },
  },
  i18n: {
    defaultLocale: 'de',
    locales: ['de', 'en'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
