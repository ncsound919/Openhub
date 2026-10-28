import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST = path.join(PUBLIC, 'manifest.webmanifest');
const SW = path.join(PUBLIC, 'sw.js');

/**
 * Installability is a static contract: Chrome drops the WebAPK prompt when a
 * declared icon 404s (the SPA fallback used to answer /icon-192.png with HTML,
 * which looked like a 200 in devtools). Keep the manifest and the files it
 * references in sync.
 */
describe('PWA assets', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as {
    name?: string;
    start_url?: string;
    icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[];
  };

  it('declares the required install metadata', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    const sizes = new Set((manifest.icons ?? []).map((i) => i.sizes));
    expect(sizes.has('192x192')).toBe(true);
    expect(sizes.has('512x512')).toBe(true);
    expect((manifest.icons ?? []).some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('ships every icon the manifest references', () => {
    for (const icon of manifest.icons ?? []) {
      expect(icon.src, 'icon src').toBeTruthy();
      const file = path.join(PUBLIC, icon.src!.replace(/^\//, ''));
      expect(fs.existsSync(file), `${icon.src} missing`).toBe(true);
      expect(fs.statSync(file).size).toBeGreaterThan(100);
    }
    expect(fs.existsSync(path.join(PUBLIC, 'apple-touch-icon.png'))).toBe(true);
  });

  it('service worker updates HTML from the network and never caches API/stream traffic', () => {
    const sw = fs.readFileSync(SW, 'utf8');
    expect(sw).toMatch(/openhub-shell-v3/);
    expect(sw).toMatch(/handleNavigation/);
    expect(sw).toMatch(/mode === 'navigate'/);
    expect(sw).toMatch(/startsWith\('\/api\/'\)/);
    expect(sw).toMatch(/startsWith\('\/ws\/'\)/);
    // Cache-first for the shell HTML is what pinned phones to an old bundle.
    expect(sw).not.toMatch(/caches\.match\(req\)\.then\(\(cached\) => \{/);
  });
});
