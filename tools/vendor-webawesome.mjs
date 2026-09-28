#!/usr/bin/env node
/* ============================================================================
 * tools/vendor-webawesome.mjs — Tidy's Web Awesome vendor manager
 * ----------------------------------------------------------------------------
 * Regenerates vendor/webawesome/dist-cdn/ so it contains ONLY the Web Awesome
 * runtime files Tidy actually uses (components, their transitive chunks,
 * internal utilities, and the CSS/theme closure). No CDN at runtime; the
 * curated vendor is committed to Git so clones run fully offline.
 *
 * Usage:
 *   npm run vendor:webawesome                       # regenerate from manifest
 *   npm run vendor:webawesome -- button icon ...    # set the component list
 *   npm run vendor:webawesome -- --add select       # add component(s)
 *   npm run vendor:webawesome -- --remove select    # remove component(s)
 *   npm run vendor:webawesome -- --check            # verify vendor is intact
 *   npm run vendor:webawesome -- --upgrade 3.15.0   # pin a new version
 *   npm run vendor:webawesome -- --source npm       # force npm pack (skip local tarball)
 *
 * Zero dependencies. Requires Node >= 18 and (for fetching) npm + tar on PATH.
 * ==========================================================================*/

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const VENDOR_DIR = path.join(PROJECT_ROOT, 'vendor', 'webawesome');
const OUT_DIR = path.join(VENDOR_DIR, 'dist-cdn');
const MANIFEST_PATH = path.join(VENDOR_DIR, 'VENDOR_MANIFEST.json');
const POPUP_HTML = path.join(PROJECT_ROOT, 'popup.html');
const POPUP_JS = path.join(PROJECT_ROOT, 'popup.js');
const LOCAL_TARBALL_DIR = path.join(PROJECT_ROOT, '.freebuff'); // git-ignored cache
const FALLBACK_VERSION = '3.14.0';
const PACKAGE = '@awesome.me/webawesome';
const DIST = 'dist-cdn';
const LOCAL_TARBALL_NAME = (v) => `awesome.me-webawesome-${v}.tgz`;

const HELP = `Usage: npm run vendor:webawesome [components...] [-- options]

Options:
  (no args)            Regenerate the vendor using the component list stored in
                       VENDOR_MANIFEST.json (or the built-in default list).
  <components...>      Set the full component list explicitly.
  --add <name>...      Add component(s) to the current list and regenerate.
  --remove <name>...   Remove component(s) from the current list and regenerate.
  --check              Verify the committed vendor matches the manifest and
                       re-resolve it against the pinned package (offline first).
  --upgrade <version>  Pin a different Web Awesome version and regenerate.
  --source npm|local   Force the package source (default: local tarball in
                       .freebuff/ if it matches the pinned version, else npm).
  --help               Show this help.

The script never edits Tidy application code. When you add or remove a
component, update popup.js imports yourself (the script will remind you).`;

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

const die = (msg) => {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const relPosix = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const posixJoin = (dir, spec) => path.posix.normalize(path.posix.join(dir, spec));

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    die(`Cannot parse ${file}: ${err.message}`);
  }
}

function rmrfSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/* -------------------------------------------------------------------------- */
/* CLI parsing                                                                 */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const opts = { components: [], add: [], remove: [], check: false, upgrade: null, source: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--add') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.add.push(argv[++i].toLowerCase()); }
    else if (a === '--remove') { while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.remove.push(argv[++i].toLowerCase()); }
    else if (a === '--upgrade') { opts.upgrade = argv[++i]; if (!opts.upgrade) die('--upgrade requires a version, e.g. --upgrade 3.15.0'); }
    else if (a === '--source') { opts.source = argv[++i]; if (!['npm', 'local'].includes(opts.source)) die("--source must be 'npm' or 'local'"); }
    else if (a === '--') { /* remaining are components */ while (i + 1 < argv.length) opts.components.push(argv[++i].toLowerCase()); }
    else if (a.startsWith('--')) die(`Unknown option: ${a}\n\n${HELP}`);
    else opts.components.push(a.toLowerCase());
  }
  return opts;
}

/* -------------------------------------------------------------------------- */
/* Manifest handling                                                           */
/* -------------------------------------------------------------------------- */

const DEFAULT_COMPONENTS = ['button', 'checkbox', 'dialog', 'icon', 'input', 'switch', 'tooltip'];

function loadState(opts) {
  const manifest = readJsonIfExists(MANIFEST_PATH);
  const version = opts.upgrade ?? manifest?.package?.version ?? FALLBACK_VERSION;
  let components;
  if (opts.components.length) components = [...new Set(opts.components)];
  else if (opts.add.length || opts.remove.length) {
    if (!manifest) die('--add/--remove require an existing manifest; list components explicitly instead.');
    components = new Set(manifest.components);
    for (const c of opts.add) {
      if (!components.delete(c) && !opts.remove.includes(c)) {
        console.log(`Note: '${c}' was not previously vendored; adding it.`);
      }
      components.add(c);
    }
    for (const c of opts.remove) {
      if (!components.delete(c)) console.log(`Note: '${c}' was not in the vendor list; nothing to remove.`);
    }
    components = [...components];
  } else components = manifest?.components ?? DEFAULT_COMPONENTS;
  if (!components.length) die('Component list is empty — nothing to vendor.');
  return { manifest, version, components };
}

/* -------------------------------------------------------------------------- */
/* Package acquisition (local tarball first, npm pack fallback)                */
/* -------------------------------------------------------------------------- */

function resolveTarball(version, source) {
  const localTarball = path.join(LOCAL_TARBALL_DIR, LOCAL_TARBALL_NAME(version));
  if (source !== 'npm' && fs.existsSync(localTarball)) {
    return { tarball: localTarball, source: 'local-tarball' };
  }
  if (source === 'local') {
    die(`Local tarball ${relPosix(PROJECT_ROOT, localTarball)} not found for ${PACKAGE}@${version}. ` +
        `Place it there or run with --source npm.`);
  }
  console.log(`Fetching ${PACKAGE}@${version} via npm pack ...`);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pack-'));
  const r = spawnSync('npm', ['pack', `${PACKAGE}@${version}`, '--pack-destination', dest], {
    shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    rmrfSync(dest);
    die(`npm pack failed (network? npm on PATH?).\n${r.stderr || r.stdout || ''}` +
        `\nOffline alternative: put ${LOCAL_TARBALL_NAME(version)} into ${relPosix(PROJECT_ROOT, LOCAL_TARBALL_DIR)}/ and rerun.`);
  }
  const produced = fs.readdirSync(dest).find((f) => f.endsWith('.tgz'));
  if (!produced) die('npm pack produced no tarball.');
  return { tarball: path.join(dest, produced), source: 'npm', cleanupDir: dest };
}

function extractPackage(tarball, tmpDir) {
  const pkgDir = path.join(tmpDir, 'package');
  if (fs.existsSync(pkgDir)) rmrfSync(pkgDir);
  // Copy into tmpDir and extract by relative name: GNU tar on Windows treats
  // `C:\...` as a remote host specifier otherwise.
  const localTar = path.join(tmpDir, 'pkg.tgz');
  fs.copyFileSync(tarball, localTar);
  const r = spawnSync('tar', ['-xzf', 'pkg.tgz'], { cwd: tmpDir, shell: process.platform === 'win32', encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(pkgDir)) {
    die(`Failed to extract tarball with system tar: ${r.stderr || 'unknown error'}`);
  }
  // Sanity: verify the package format we know how to resolve.
  const distCdn = path.join(pkgDir, DIST);
  for (const must of [distCdn, path.join(distCdn, 'webawesome.js'), path.join(distCdn, 'chunks'), path.join(pkgDir, 'package.json')]) {
    if (!fs.existsSync(must)) {
      die(`Package format incompatible: expected ${relPosix(pkgDir, must)} inside the tarball. ` +
          `The ${DIST} layout may have changed upstream; this resolver must be updated.`);
    }
  }
  const pkgJson = readJsonIfExists(path.join(pkgDir, 'package.json'));
  if (pkgJson?.version !== undefined) {
    const claimed = pkgJson.version;
    // The tarball filename may pin a version; trust package.json and warn on mismatch.
    return { pkgDir, distCdn, pkgVersion: claimed };
  }
  return { pkgDir, distCdn, pkgVersion: null };
}

/* -------------------------------------------------------------------------- */
/* Dependency resolution                                                       */
/* -------------------------------------------------------------------------- */

/* Static JS imports: `from "..."`, `import "..."`, and literal dynamic
 * `import("...")`. Anything else (computed import(), bare specifiers) is
 * reported so the run can fail loudly instead of producing a broken vendor. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
const DYN_RE = /\bimport\s*\(/g;

function resolveJsClosure(distCdn, jsEntrypoints) {
  const seen = new Map(); // relPath -> size
  const problems = { missing: [], bare: [], computedDynamic: [] };
  const queue = [...jsEntrypoints];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(distCdn, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { problems.missing.push(rel); continue; }
    seen.set(rel, fs.statSync(abs).size);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) { problems.bare.push(`${rel} -> ${spec}`); continue; }
      queue.push(posixJoin(path.posix.dirname(rel), spec));
    }
    for (const m of src.matchAll(DYN_RE)) {
      const tail = src.slice(m.index, m.index + 80).replace(/\s+/g, ' ');
      if (!/^import\s*\(\s*['"]/.test(tail)) problems.computedDynamic.push(`${rel} :: ${tail}...`);
    }
  }
  return { files: seen, problems };
}

/* CSS closure: @import "..." / url("...") references to other .css files.
 * Non-CSS url() targets (data:, fonts) are expected to be self-contained. */
function resolveCssClosure(distCdn, cssEntrypoints) {
  const seen = new Map();
  const problems = { missing: [], externalOrDataUrls: 0 };
  const queue = [...cssEntrypoints];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(distCdn, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { problems.missing.push(rel); continue; }
    seen.set(rel, fs.statSync(abs).size);
    const src = fs.readFileSync(abs, 'utf8');
    const dir = path.posix.dirname(rel);
    const refs = [];
    for (const m of src.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'";\s)]+)/g)) refs.push(m[1]);
    for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)/g)) refs.push(m[1]);
    for (const spec of refs) {
      if (/^(data:|https?:|\/\/|#)/i.test(spec)) { problems.externalOrDataUrls++; continue; }
      const target = posixJoin(dir, spec);
      if (/\.css$/i.test(target)) queue.push(target);
      else problems.externalOrDataUrls++;
    }
  }
  return { files: seen, problems };
}

/* Entrypoints are derived from the app itself, never hard-coded:
 *  - JS: the wa component imports in popup.js + the webawesome.js helper import
 *  - CSS: the dist-cdn stylesheet links in popup.html */
function deriveEntrypoints(distCdn) {
  const jsEntrypoints = new Set(['webawesome.js']);
  const popupJs = fs.readFileSync(POPUP_JS, 'utf8');
  for (const m of popupJs.matchAll(/['"][^'"]*dist-cdn\/(components\/[a-z0-9-]+\/[a-z0-9-]+\.js|webawesome\.js)['"]/g)) {
    jsEntrypoints.add(m[1]);
  }
  if (jsEntrypoints.size === 1) die(`No Web Awesome imports found in ${relPosix(PROJECT_ROOT, POPUP_JS)}. Is this the right project?`);
  // Verify every requested component has a real import in the app (warn otherwise).
  const popupHtml = fs.readFileSync(POPUP_HTML, 'utf8');
  const cssEntrypoints = new Set();
  for (const m of popupHtml.matchAll(/<link[^>]+href=['"]([^'"]*dist-cdn\/styles\/[^'"]+\.css)['"]/g)) {
    cssEntrypoints.add(m[1].replace(/^.*?dist-cdn\//, ''));
  }
  if (!cssEntrypoints.size) die(`No dist-cdn stylesheet links found in ${relPosix(PROJECT_ROOT, POPUP_HTML)}.`);
  for (const rel of jsEntrypoints) {
    if (!fs.existsSync(path.join(distCdn, rel))) die(`Entrypoint ${rel} does not exist in the package's ${DIST}/ — component renamed upstream?`);
  }
  for (const rel of cssEntrypoints) {
    if (!fs.existsSync(path.join(distCdn, rel))) die(`Stylesheet ${rel} does not exist in the package's ${DIST}/.`);
  }
  return { jsEntrypoints: [...jsEntrypoints].sort(), cssEntrypoints: [...cssEntrypoints].sort() };
}

/* Components are resolution roots too: a component added via --add must be
 * vendored even though the app does not import it yet (the developer adds the
 * static import afterwards — the script only reminds them to do so). */
function withComponentRoots(jsEntrypoints, components, distCdn) {
  const all = new Set(jsEntrypoints);
  for (const c of components) all.add(`components/${c}/${c}.js`);
  for (const rel of all) {
    if (!fs.existsSync(path.join(distCdn, rel))) {
      die(`Unknown component '${rel.split('/')[1]}' — no ${rel} in the package's ${DIST}/. ` +
          `Check the exact component name at webawesome.com/docs/components.`);
    }
  }
  return [...all].sort();
}

/* -------------------------------------------------------------------------- */
/* Copy + manifest                                                             */
/* -------------------------------------------------------------------------- */

function copyClosure(filesMap, srcRoot, outRoot) {
  for (const rel of [...filesMap.keys()].sort()) {
    const dest = path.join(outRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcRoot, rel), dest);
  }
}

/* Tidy is a fully self-contained Chrome extension: no remote requests at
 * runtime. The upstream awesome theme imports the Bunny Fonts webfont CDN,
 * which the extension CSP (style-src 'self') would block anyway. We strip
 * exactly that one @import during generation — nothing else in the CSS is
 * touched. This is the single source of truth for the removal: the generated
 * vendor must never contain the line, and every regeneration is identical. */
const AWESOME_THEME_REL = 'styles/themes/awesome.css';
const BUNNY_IMPORT_RE =
  /^[ \t]*@import\s+url\(\s*['"]https?:\/\/fonts\.bunny\.net\/[^'"()]*['"]\s*\)\s*;[^\n]*(?:\n|$)/gm;
const BUNNY_REMOVAL_COMMENT =
  `/* Self-hosted fonts only: the upstream Bunny Fonts @import was removed so the\n` +
  ` * extension stays fully offline (CSP style-src 'self' blocked it anyway).\n` +
  ` * Typography comes from vendor/fonts (Instrument Sans) via popup.css. */\n`;

function applyOfflinePatches(outRoot) {
  const abs = path.join(outRoot, ...AWESOME_THEME_REL.split('/'));
  if (!fs.existsSync(abs)) die(`Offline patch failed: ${AWESOME_THEME_REL} missing from generated vendor.`);
  const src = fs.readFileSync(abs, 'utf8');
  const cleaned = src.replace(BUNNY_IMPORT_RE, BUNNY_REMOVAL_COMMENT);
  if (cleaned === src) die(`Offline patch failed: no Bunny Fonts @import found in ${AWESOME_THEME_REL} — upstream package changed?`);
  if (/fonts\.bunny\.net/.test(cleaned)) die(`Offline patch failed: fonts.bunny.net still referenced in ${AWESOME_THEME_REL}.`);
  fs.writeFileSync(abs, cleaned);
}

function buildFileRecords(outRoot) {
  const records = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else records.push({ path: relPosix(outRoot, abs), sha256: sha256(fs.readFileSync(abs)), size: fs.statSync(abs).size });
    }
  };
  walk(outRoot);
  return records;
}

function writeManifest({ pkg, pkgVersion, integrity, components, entrypoints, jsStats, cssStats, outRoot, source }) {
  const files = buildFileRecords(outRoot);
  const totalBytes = files.reduce((t, f) => t + f.size, 0);
  const manifest = {
    $schema: 'https://json.schemastore.org/json',
    package: { name: PACKAGE, version: pkgVersion, integrity, source },
    components: [...components].sort(),
    entrypoints: { js: entrypoints.jsEntrypoints, css: entrypoints.cssEntrypoints },
    resolution: {
      jsFiles: jsStats.files.size,
      cssFiles: cssStats.files.size,
      bareSpecifiers: 0,
      missingDependencies: 0,
      computedDynamicImports: jsStats.computedDynamic.length,
      notes: [
        'JS closure resolved from static relative imports in dist-cdn chunks.',
        'dist-cdn bundles all third-party dependencies (Lit, Floating UI, ...); no node_modules needed at runtime.',
        'System icons (play/pause/gear/...) are embedded data-URI SVGs; no icon files are fetched.',
        'English UI strings are inlined in components; translations/ is intentionally excluded.',
        'The autoloader chunk is included because webawesome.js exports it, but Tidy statically imports every component and never calls startLoader().',
      ],
    },
    files,
    stats: { fileCount: files.length, totalBytes },
    generatedWith: { script: 'tools/vendor-webawesome.mjs', node: process.version },
  };
  const json = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(MANIFEST_PATH, json);
  return { manifest, totalBytes };
}

/* -------------------------------------------------------------------------- */
/* App-import sanity warnings (read-only; never edits app code)                */
/* -------------------------------------------------------------------------- */

function warnAboutAppImports(components) {
  const popupJs = fs.readFileSync(POPUP_JS, 'utf8');
  const imported = new Set([...popupJs.matchAll(/dist-cdn\/components\/([a-z0-9-]+)\//g)].map((m) => m[1]));
  for (const c of components) {
    if (!imported.has(c)) {
      console.log(`REMINDER: component '${c}' is vendored but popup.js has no static import for it. ` +
          `Add  import './vendor/webawesome/${DIST}/components/${c}/${c}.js';  if the UI uses <wa-${c}>.`);
    }
  }
  for (const c of imported) {
    if (!components.includes(c)) {
      console.log(`WARNING: popup.js imports <wa-${c}> but it is NOT in the vendor component list — ` +
          `the UI will break at runtime. Re-run with '${c}' in the list.`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main operations                                                             */
/* -------------------------------------------------------------------------- */

function generate({ manifest, version, components, source }) {
  const { tarball, source: usedSource, cleanupDir } = resolveTarball(version, source);
  const tmp = fs.mkdtempSync(path.join(LOCAL_TARBALL_DIR, 'vendor-build-'));
  try {
    console.log(`Extracting ${relPosix(PROJECT_ROOT, tarball)} ...`);
    const { pkgDir, distCdn, pkgVersion } = extractPackage(tarball, tmp);
    if (pkgVersion && pkgVersion !== version) {
      die(`Pinned version ${version} does not match package.json version ${pkgVersion} inside the tarball.`);
    }
    const integrity = 'sha256-' + sha256(fs.readFileSync(tarball));

    const appEntrypoints = deriveEntrypoints(distCdn);
    const jsEntrypoints = withComponentRoots(appEntrypoints.jsEntrypoints, components, distCdn);
    const js = resolveJsClosure(distCdn, jsEntrypoints);
    const css = resolveCssClosure(distCdn, appEntrypoints.cssEntrypoints);

    if (js.problems.missing.length || js.problems.bare.length || css.problems.missing.length) {
      const fmt = (a) => a.map((s) => `  - ${s}`).join('\n');
      die(`Dependency resolution failed — refusing to touch the existing vendor.\n` +
          (js.problems.missing.length ? `\nMissing JS files:\n${fmt(js.problems.missing)}\n` : '') +
          (js.problems.bare.length ? `\nBare (non-relative) specifiers — package format not self-contained:\n${fmt(js.problems.bare)}\n` : '') +
          (css.problems.missing.length ? `\nMissing CSS files:\n${fmt(css.problems.missing)}\n` : ''));
    }
    if (js.problems.computedDynamic.length) {
      console.log(`Note: ${js.problems.computedDynamic.length} computed dynamic import(s) detected (expected: the wa autoloader). ` +
          `They are kept as-is; every component Tidy uses is statically imported, so they must never resolve at runtime.`);
    }

    // Build the curated vendor in the temp dir, validate, then swap atomically.
    const outRoot = path.join(tmp, 'out', DIST);
    fs.mkdirSync(outRoot, { recursive: true });
    copyClosure(js.files, distCdn, outRoot);
    copyClosure(css.files, distCdn, outRoot);
    applyOfflinePatches(outRoot);

    validateGenerated(outRoot, components, jsEntrypoints);

    const { totalBytes } = writeManifest({ pkg: PACKAGE, pkgVersion: pkgVersion ?? version, integrity, components, entrypoints: { jsEntrypoints, cssEntrypoints: appEntrypoints.cssEntrypoints }, jsStats: { ...js.problems, files: js.files }, cssStats: css, outRoot, source: usedSource });

    // Swap the real vendor (old dist-cdn fully replaced by the curated set).
    if (fs.existsSync(OUT_DIR)) rmrfSync(OUT_DIR);
    fs.cpSync(outRoot, OUT_DIR, { recursive: true });
    // Preserve license + provenance at the vendor root.
    fs.copyFileSync(path.join(pkgDir, 'LICENSE.md'), path.join(VENDOR_DIR, 'LICENSE.md'));
    fs.copyFileSync(path.join(pkgDir, 'package.json'), path.join(VENDOR_DIR, 'package.json'));

    const jsCount = js.files.size, cssCount = css.files.size;
    console.log(`\nOK: curated vendor generated.`);
    console.log(`  Components : ${[...components].sort().join(', ')}`);
    console.log(`  JS files   : ${jsCount} (${(jsCount && [...js.files.values()].reduce((a, b) => a + b, 0) / 1024).toFixed(0)} KB)`);
    console.log(`  CSS files  : ${cssCount} (${[...css.files.values()].reduce((a, b) => a + b, 0) / 1024 | 0} KB)`);
    console.log(`  Total      : ${totalBytes / 1024 | 0} KB across ${jsCount + cssCount} runtime files`);
    console.log(`  Source     : ${PACKAGE}@${pkgVersion ?? version} (${usedSource}, ${integrity.slice(0, 19)}...)`);
    warnAboutAppImports(components);
    if (cleanupDir) rmrfSync(cleanupDir);
    return { manifestBytes: totalBytes };
  } finally {
    rmrfSync(tmp);
  }
}

function validateGenerated(outRoot, components, jsEntrypoints) {
  for (const c of components) {
    const p = path.join(outRoot, 'components', c, `${c}.js`);
    if (!fs.existsSync(p)) die(`Validation failed: generated vendor is missing components/${c}/${c}.js`);
  }
  for (const rel of [...jsEntrypoints]) {
    if (!fs.existsSync(path.join(outRoot, rel))) die(`Validation failed: generated vendor is missing ${rel}`);
  }
  const allowedTop = new Set(['components', 'chunks', 'internal', 'utilities', 'styles', 'webawesome.js']);
  for (const entry of fs.readdirSync(outRoot)) {
    if (!allowedTop.has(entry)) die(`Validation failed: unexpected top-level entry '${entry}' in generated vendor.`);
  }
  // Chunks referenced by copied files must exist inside the vendor (closure sanity).
  for (const f of fs.readdirSync(path.join(outRoot, 'chunks'))) {
    if (!f.endsWith('.js')) die(`Validation failed: unexpected non-JS file in chunks/: ${f}`);
  }
}

function check(opts) {
  const manifest = readJsonIfExists(MANIFEST_PATH);
  if (!manifest) die('No VENDOR_MANIFEST.json found — run the generator first.');
  let drift = false;

  // 1) Worktree matches the manifest (works fully offline, no package needed).
  for (const f of manifest.files) {
    const abs = path.join(OUT_DIR, f.path);
    if (!fs.existsSync(abs)) { console.error(`MISSING  ${f.path}`); drift = true; continue; }
    const buf = fs.readFileSync(abs);
    if (buf.length !== f.size || sha256(buf) !== f.sha256) { console.error(`MODIFIED ${f.path}`); drift = true; }
  }
  const known = new Set(manifest.files.map((f) => f.path));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (!known.has(relPosix(OUT_DIR, abs))) { console.error(`EXTRA   ${relPosix(OUT_DIR, abs)}`); drift = true; }
    }
  };
  if (fs.existsSync(OUT_DIR)) walk(OUT_DIR); else { console.error('MISSING dist-cdn/ entirely'); drift = true; }

  // 2) Re-resolve against the pinned package when a source is available.
  let reResolved = false;
  try {
    const { tarball, source } = resolveTarball(manifest.package.version, opts.source);
    const tmp = fs.mkdtempSync(path.join(LOCAL_TARBALL_DIR, 'check-'));
    try {
      const { distCdn } = extractPackage(tarball, tmp);
      const js = resolveJsClosure(distCdn, manifest.entrypoints.js);
      const css = resolveCssClosure(distCdn, manifest.entrypoints.css);
      const expected = new Set([...js.files.keys(), ...css.files.keys()]);
      const have = new Set([...known].filter((p) => !['LICENSE.md'].includes(p)));
      for (const f of expected) if (!have.has(f)) { console.error(`VENDOR LACKS (per fresh resolution): ${f}`); drift = true; }
      for (const f of have) if (!expected.has(f)) { console.error(`VENDOR HAS EXTRA (per fresh resolution): ${f}`); drift = true; }
      if (js.problems.missing.length || js.problems.bare.length) {
        console.error('Fresh resolution reported problems (package format changed?):');
        for (const p of [...js.problems.missing, ...js.problems.bare]) console.error(`  - ${p}`);
        drift = true;
      }
      reResolved = true;
      console.log(`(re-resolved against ${manifest.package.version} via ${source})`);
    } finally { rmrfSync(tmp); if (source === 'npm') rmrfSync(path.dirname(tarball)); }
  } catch (err) {
    console.log(`(skipped fresh re-resolution: ${String(err.message).split('\n')[0]})`);
  }

  if (drift) { console.error('\nCHECK FAILED: vendor does not match the manifest/package.'); process.exit(1); }
  console.log(`\nCHECK OK: ${manifest.files.length} files verified against manifest${reResolved ? ' + fresh re-resolution' : ''}.`);
  console.log(`Pinned: ${manifest.package.name}@${manifest.package.version} | components: ${manifest.components.join(', ')}`);
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(HELP); process.exit(0); }
const state = loadState(opts);
console.log(`Web Awesome vendor manager — target version ${state.version}`);
if (opts.check) check(opts);
else {
  generate(state);
  console.log('\nNext steps: review the diff, then load the extension and test.');
}
