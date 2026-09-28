# Vendored dependencies

Tidy ships a **curated subset of Web Awesome** (v3.14.0) instead of the full
package. This keeps the repo and the published extension small while staying
**100% self-contained at runtime** — no CDN, no remote JS/CSS/fonts.

## Why only a subset?

The full Web Awesome browser distribution (`dist-cdn/` of v3.14.0) is ~11 MB:
73 components plus translations, AI docs, IDE metadata, and other package
content. Tidy uses 7 components, whose resolved runtime is ~0.5 MB. A script
resolves exactly the files those components depend on, so nothing unused ships
and nothing needed is missing.

## What is included

Components (see `vendor/webawesome/VENDOR_MANIFEST.json` for the live list):
`button`, `checkbox`, `dialog`, `icon`, `input`, `switch`, `tooltip`.

The generated vendor contains only:

- the component entry files above,
- every JS chunk they transitively import (all third-party libraries — Lit,
  Floating UI, etc. — are already bundled inside those chunks),
- the CSS closure of the two stylesheets linked from `popup.html`
  (`styles/webawesome.css` and `styles/themes/awesome.css`),
- `webawesome.js` (the `setBasePath` / icon-library helpers Tidy imports),
- `LICENSE.md` and `package.json` at `vendor/webawesome/` for attribution and
  version provenance.

Everything else from the package (docs, types, React wrappers, SSR, IDE
metadata, translations, unused components) is intentionally **not** vendored.
Tidy's own icons in `icons/` and the Instrument Sans font in `vendor/fonts/`
are separate, hand-managed files — the script never touches them.

## How it is generated

```
npm run vendor:webawesome
```

The script (`tools/vendor-webawesome.mjs`, zero dependencies):

1. reads the component list from `VENDOR_MANIFEST.json`,
2. extracts `@awesome.me/webawesome@<pinned version>` — preferring the local
   tarball in `.freebuff/`, falling back to `npm pack` (network needed only if
   the tarball is absent),
3. walks the actual import graph (static JS imports + CSS `@import`/`url()`)
   starting from the entry points it finds in `popup.js` / `popup.html`,
4. copies the resolved file set into `vendor/webawesome/dist-cdn/`,
   rewrites the manifest (SHA-256 per file), and fails loudly — without
   touching the existing vendor — if anything cannot be resolved,
5. applies one documented, deterministic patch while copying: the upstream
   `styles/themes/awesome.css` imports webfonts from fonts.bunny.net, which
   Tidy's CSP (`style-src 'self'`) blocks anyway; the script strips exactly
   that `@import` (nothing else in the CSS is modified) and replaces it with
   an explanatory comment. If upstream removes or renames the import, the
   script fails instead of silently drifting from the committed vendor.

Re-running it produces byte-identical output (idempotent).

### The vendor is generated output — never hand-edit it

`dist-cdn/` and `VENDOR_MANIFEST.json` are committed **build artifacts**, kept
in Git only so clones work offline. Never:

- copy individual Web Awesome files into the vendor by hand,
- delete chunks that *look* unused — the closure is transitive; a missing
  chunk breaks a component at runtime,
- edit hashes, file lists, or stats in `VENDOR_MANIFEST.json`,
- patch vendored files directly (that includes the Bunny Fonts removal) — such
  changes belong in `tools/vendor-webawesome.mjs`, the single source of truth.

To change the vendor, change the component list or the script and regenerate.
`npm run vendor:webawesome -- --check` fails if the committed vendor ever
 drifts from what the generator would produce.

## Common tasks

**Add a component** (e.g. `select`):

```
npm run vendor:webawesome -- --add select
```

Then add the static import in `popup.js` yourself — the script never edits app
code and will print a reminder:

```js
import './vendor/webawesome/dist-cdn/components/select/select.js';
```

**Remove a component:** `npm run vendor:webawesome -- --remove select`
(also remove the import from `popup.js`).

**Verify a clone is intact:** `npm run vendor:webawesome -- --check`

**Upgrade Web Awesome:** `npm run vendor:webawesome -- --upgrade 3.15.0`,
then review the diff and test the UI. The version is pinned exactly (no
semver ranges) so everyone generates the same vendor.

## Why the vendor is committed

Tidy is a no-build Chrome extension: anyone can clone the repo and load it via
`chrome://extensions` → *Load unpacked*. Cloning and running therefore need
**no npm, no internet, no build step**. npm/network access is only required
when regenerating or upgrading the vendor.

## Known limitations

- **Dormant autoloader.** Web Awesome's autoloader can lazy-load components at
  runtime by convention. Tidy does not use it — every component must be
  statically imported in `popup.js` (and vendored via the script). An
  un-vendored `<wa-*>` tag simply never upgrades.
- **Dynamic imports.** The resolver rejects computed dynamic imports; the one
  known instance (the autoloader itself) is expected and documented. If a
  future Web Awesome version adds another, the script will fail loudly rather
  than ship a broken vendor.
- **Translations.** Only the inlined English strings are used; the package's
  `translations/` directory is excluded. If Tidy ever needs localized UI,
  revisit this.
- **Icons.** System icons are embedded data-URIs inside the vendor; the
  `lucide` library resolves to local files in `icons/`. Registering any
  *remote* icon library would break offline behavior and is out of scope.

## Layout

```
tools/vendor-webawesome.mjs      # the vendor manager (Node, zero deps)
vendor/webawesome/
├── VENDOR_MANIFEST.json         # generated: version, files, SHA-256s, stats
├── LICENSE.md / package.json    # preserved from the package (MIT, provenance)
└── dist-cdn/                    # generated curated runtime (~0.5 MB)
```
