// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Set to the real domain once it exists (used for canonical/hreflang/OG URLs).
  site: 'https://www.tsv-steinsfurt.de',
  trailingSlash: 'ignore',
  build: {
    // /en/ -> dist/en/index.html (the CloudFront Function maps /en/ to it)
    format: 'directory',
  },
  i18n: {
    defaultLocale: 'de',
    locales: ['de', 'en'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
