import type { ImageMetadata } from 'astro';

/**
 * All images in src/assets/placeholders (and later src/assets/photos) keyed by file name
 * without extension, e.g. "team-erste". The i18n JSON refers to images by this key.
 * To use a real photo, drop e.g. `team-erste.jpg` into src/assets/photos/. It takes
 * precedence over the placeholder with the same name.
 */
const placeholders = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/placeholders/*.{jpg,jpeg,png,webp,avif}',
  { eager: true },
);
const photos = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/photos/*.{jpg,jpeg,png,webp,avif}',
  { eager: true },
);

const byKey = new Map<string, ImageMetadata>();
for (const [path, mod] of [...Object.entries(placeholders), ...Object.entries(photos)]) {
  const key = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  byKey.set(key, mod.default);
}

export function img(key: string): ImageMetadata {
  const found = byKey.get(key);
  if (!found) throw new Error(`Image "${key}" not found in src/assets/photos or src/assets/placeholders`);
  return found;
}
