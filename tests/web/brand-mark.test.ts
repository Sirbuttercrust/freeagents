// BR5: the FreeAgents logo, the favicon set and the link-preview tags.
//
// Three properties, each asserted where it can fail:
//
// 1. Every page head carries the icon links and the card tags. Read from the
//    files on disk and parsed, so a page added later without them turns this
//    red rather than slipping past a list of names.
// 2. Every page's .brand link holds the logo from the approved kit and keeps
//    its accessible name, on the built pages and the wireframes alike.
// 3. The icon, manifest and card-image paths answer 200 with the right
//    content type through the real app, and the bytes are the committed
//    files, so a route pointed at the wrong directory cannot pass.

import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/api/app.js';
import { MemoryAccountRepository, MemoryAgentRepository } from '../../src/adapters/storage/memory.js';
import { ROOT_ICONS } from '../../src/web/static.js';

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, '../../src/web/pages');
const wireDir = join(here, '../../spec/wireframe');
const publicDir = join(here, '../../src/web/public');

const DEFAULT_DESCRIPTION = 'The marketplace for specialized AI agents.';

const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.html'));
const wireframes = readdirSync(wireDir).filter((f) => f.endsWith('.html'));

// Pages with a nav. The OAuth callback success page is a one-line holding
// screen that redirects on load and has never had a nav, so it carries the
// head tags but no brand link.
const NO_NAV = new Set(['auth-callback-success.html']);

function parse(file: string): Document {
  return new JSDOM(readFileSync(file, 'utf8')).window.document;
}

function meta(doc: Document, attr: 'property' | 'name', key: string): string | null {
  return doc.head.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;
}

describe('every page head carries the icons and the link-preview card', () => {
  it('found the pages', () => {
    expect(pages.length).toBeGreaterThanOrEqual(25);
  });

  it.each(pages)('%s links the favicon set and the manifest', (file) => {
    const head = parse(join(pagesDir, file)).head;
    const href = (sel: string) => head.querySelector(sel)?.getAttribute('href');
    expect(href('link[rel="icon"][href="/favicon.ico"]')).toBe('/favicon.ico');
    expect(head.querySelector('link[rel="icon"][href="/favicon.svg"]')?.getAttribute('type')).toBe('image/svg+xml');
    expect(href('link[rel="apple-touch-icon"]')).toBe('/apple-touch-icon.png');
    expect(href('link[rel="manifest"]')).toBe('/site.webmanifest');
  });

  it.each(pages)('%s carries og:title, og:description, og:image and twitter:card', (file) => {
    const doc = parse(join(pagesDir, file));
    const description = meta(doc, 'name', 'description');
    expect(meta(doc, 'property', 'og:title'), 'og:title is the page title').toBe(doc.title);
    expect(meta(doc, 'property', 'og:description')).toBe(description ?? DEFAULT_DESCRIPTION);
    // Root-relative until the domain serves the site; the absolute form is a
    // go-live change, not this card's.
    expect(meta(doc, 'property', 'og:image')).toBe('/assets/brand/og-1200x630.png');
    expect(meta(doc, 'name', 'twitter:card')).toBe('summary_large_image');
  });
});

describe('the brand link is the logo and keeps its name', () => {
  const cases = [
    ...pages.filter((f) => !NO_NAV.has(f)).map((f) => ['built', join(pagesDir, f), '/assets/brand/'] as const),
    ...wireframes.map((f) => ['wireframe', join(wireDir, f), 'brand/'] as const),
  ];

  it.each(cases)('%s %s', (_kind, file, prefix) => {
    const doc = parse(file);
    const brands = doc.querySelectorAll('.brand');
    expect(brands.length, 'one brand link per page').toBe(1);
    const brand = brands[0] as Element;
    expect(brand.tagName).toBe('A');
    expect(brand.getAttribute('aria-label')).toBe('FreeAgents home');
    // No text node: the name is the label, and a stray word would be read
    // twice by some screen readers and shown beside the lockup at desktop.
    expect((brand.textContent ?? '').trim()).toBe('');
    expect(brand.querySelector('.mark'), 'the old accent dot is gone').toBeNull();

    const lockup = brand.querySelector('img.logo-lockup');
    const icon = brand.querySelector('img.logo-icon');
    expect(lockup?.getAttribute('src')).toBe(`${prefix}freeagents-logo-dark.svg`);
    expect(icon?.getAttribute('src')).toBe(`${prefix}freeagents-icon-dark.svg`);
    // Decorative inside a labelled link. A non-empty alt would join the
    // accessible name and change what the link announces.
    expect(lockup?.getAttribute('alt')).toBe('');
    expect(icon?.getAttribute('alt')).toBe('');
  });

  it('the built site and the wireframe ship byte-identical logo files', () => {
    for (const f of ['freeagents-logo-dark.svg', 'freeagents-icon-dark.svg']) {
      const built = readFileSync(join(publicDir, 'assets', 'brand', f));
      const wire = readFileSync(join(wireDir, 'brand', f));
      expect(built.equals(wire), f).toBe(true);
    }
  });

  it('nothing styles or renders the retired accent dot', () => {
    for (const css of ['base.css', 'landing.css']) {
      expect(readFileSync(join(publicDir, 'css', css), 'utf8')).not.toMatch(/\.brand \.mark/);
    }
    expect(readFileSync(join(wireDir, 'base.css'), 'utf8')).not.toMatch(/\.brand \.mark/);
    expect(readFileSync(join(publicDir, 'js', 'landing', 'cast.js'), 'utf8')).not.toContain('navmark');
  });
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp(new MemoryAccountRepository(), new MemoryAgentRepository()).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the icon, manifest and card-image routes through the real app', () => {
  it('mounts the whole favicon set the kit ships', () => {
    const names = ROOT_ICONS.map(([f]) => f).sort();
    expect(names).toEqual(
      [
        'apple-touch-icon.png',
        'favicon.ico',
        'favicon.svg',
        'icon-192.png',
        'icon-512-maskable.png',
        'icon-512.png',
        'site.webmanifest',
      ].sort(),
    );
  });

  it.each([
    ['/favicon.ico', 'image/x-icon', 'icons/favicon.ico'],
    ['/favicon.svg', 'image/svg+xml', 'icons/favicon.svg'],
    ['/apple-touch-icon.png', 'image/png', 'icons/apple-touch-icon.png'],
    ['/icon-192.png', 'image/png', 'icons/icon-192.png'],
    ['/icon-512.png', 'image/png', 'icons/icon-512.png'],
    ['/icon-512-maskable.png', 'image/png', 'icons/icon-512-maskable.png'],
    ['/site.webmanifest', 'application/manifest+json', 'icons/site.webmanifest'],
    ['/assets/brand/og-1200x630.png', 'image/png', 'assets/brand/og-1200x630.png'],
    ['/assets/brand/freeagents-logo-dark.svg', 'image/svg+xml', 'assets/brand/freeagents-logo-dark.svg'],
    ['/assets/brand/freeagents-icon-dark.svg', 'image/svg+xml', 'assets/brand/freeagents-icon-dark.svg'],
  ])('GET %s answers 200 as %s with the committed bytes', async (path, type, file) => {
    // `*/*` is what a browser sends for an icon fetch and what an unfurler
    // sends for an image; it must not be mistaken for a page request.
    const res = await fetch(`${baseUrl}${path}`, { headers: { Accept: '*/*' } });
    expect(res.status).toBe(200);
    expect(String(res.headers.get('content-type')).split(';')[0]).toBe(type);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(readFileSync(join(publicDir, file)))).toBe(true);
  });

  it('the manifest names the three app icons, and each one it names is served', async () => {
    const res = await fetch(`${baseUrl}/site.webmanifest`);
    const manifest = (await res.json()) as { icons: { src: string; sizes: string; purpose?: string }[] };
    expect(manifest.icons.map((i) => [i.src, i.sizes, i.purpose ?? 'any'])).toEqual([
      ['/icon-192.png', '192x192', 'any'],
      ['/icon-512.png', '512x512', 'any'],
      ['/icon-512-maskable.png', '512x512', 'maskable'],
    ]);
    for (const icon of manifest.icons) {
      const r = await fetch(`${baseUrl}${icon.src}`);
      expect(r.status, icon.src).toBe(200);
    }
  });

  it('an icon name the kit does not ship still falls through to the JSON 404', async () => {
    const res = await fetch(`${baseUrl}/favicon.png`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});
