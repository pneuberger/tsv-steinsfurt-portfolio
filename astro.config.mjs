// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Public address of the site (used for canonical/hreflang/OG URLs).
  // For now the CloudFront URL; switch to the custom domain once one is set up.
  // The site is independent of the club homepage (tsvphoenixsteinsfurt.de).
  site: 'https://d384ezf8yukgl8.cloudfront.net',
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
