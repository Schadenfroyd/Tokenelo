#!/usr/bin/env node
await import('./build-report-host.mjs');
/**
 * Tray build: esbuild-bundles the Chromium-side renderer (DOM), then tsc-compiles the
 * Electron main/preload scripts (Node side) with tsconfig.tray.json. Copies static
 * renderer assets (index.html, styles.css) verbatim. Safe to run before the tray/
 * sources exist yet — each step is skipped with a warning rather than failing the
 * whole scaffold/build pipeline.
 *
 * DESIGN.md §2.1 layout: src/tray/main.ts, preload.ts, renderer/{index.html,app.ts,charts.ts,styles.css}.
 * Also bundles renderer/detail.ts -> dist/tray/renderer/detail.js (the session-detail window,
 * founder req. 2026-09-27) and copies its detail.html/detail.css alongside the popover's assets.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererOutDir = path.join(root, 'dist/tray/renderer');
const rendererEntries = [
  { src: path.join(root, 'src/tray/renderer/app.ts'), out: path.join(rendererOutDir, 'app.js') },
  { src: path.join(root, 'src/tray/renderer/detail.ts'), out: path.join(rendererOutDir, 'detail.js') },
];

function warnSkip(what, why) {
  console.warn(`[build:tray] skipping ${what}: ${why}`);
}

// `cmd` is a node_modules/.bin/<name> path (no extension). On macOS/Linux this is either a
// shebang script or (after some packages' postinstall replaces it, e.g. esbuild) a native
// binary — either way POSIX execs it directly, no shell needed. On Windows the file at that
// exact path doesn't exist; npm creates <name>.cmd/.ps1 shims instead, and Node's
// child_process refuses to spawn a .cmd directly without `shell: true` (EINVAL — deliberate
// hardening against CVE-2024-27980). So on win32 we target the .cmd shim and go through a
// shell — using execSync with a manually quoted command line (rather than execFileSync's
// `shell: true` + args array) avoids the DEP0190 "unescaped shell args" warning on every build.
function run(cmd, args) {
  if (process.platform === 'win32') {
    const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    const line = [`${cmd}.cmd`, ...args].map(quote).join(' ');
    execSync(line, { stdio: 'inherit', cwd: root, windowsHide: true });
  } else {
    execFileSync(cmd, args, { stdio: 'inherit', cwd: root, windowsHide: true });
  }
}

// 1. esbuild bundle of each renderer entry point (runs in Chromium, so it needs the DOM lib —
//    see tsconfig.tray.json / src/tray/renderer/tsconfig.json, not this script's concern).
for (const { src, out } of rendererEntries) {
  if (existsSync(src)) {
    mkdirSync(rendererOutDir, { recursive: true });
    run(path.join(root, 'node_modules/.bin/esbuild'), [
      src,
      '--bundle',
      '--platform=browser',
      '--format=esm',
      `--outfile=${out}`,
      '--sourcemap',
    ]);
  } else {
    warnSkip('renderer bundle', `${path.relative(root, src)} does not exist yet`);
  }
}

// 2. Copy static renderer assets verbatim (esbuild does not touch these).
for (const asset of ['index.html', 'styles.css', 'detail.html', 'detail.css']) {
  const src = path.join(root, 'src/tray/renderer', asset);
  const dest = path.join(rendererOutDir, asset);
  if (existsSync(src)) {
    mkdirSync(rendererOutDir, { recursive: true });
    copyFileSync(src, dest);
  } else {
    warnSkip(`copy ${asset}`, `${path.relative(root, src)} does not exist yet`);
  }
}

// 3. tsc for the Electron main/preload scripts (Node side). These are plain Node/Electron
//    -main-process TypeScript with no DOM lib, so they compile as part of the normal
//    src/** build (tsconfig.json — see its header comment for why the renderer is excluded
//    from that project and typechecked separately via tsconfig.tray.json instead).
const mainEntry = path.join(root, 'src/tray/main.ts');
const preloadEntry = path.join(root, 'src/tray/preload.ts');
if (existsSync(mainEntry) && existsSync(preloadEntry)) {
  run(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json']);
} else {
  warnSkip('tray main/preload tsc', 'src/tray/main.ts and/or preload.ts do not exist yet');
}

// 4. Re-bundle preload.ts to CommonJS, overwriting step 3's plain tsc output at the same path.
//    Verified 2026-09-26 (Electron 44 on M4a, `--enable-logging=stderr`): a preload script
//    compiled by tsc under this repo's NodeNext module setting (package.json "type":"module")
//    emits `import`/`export`, but Electron always loads `webPreferences.preload` through its own
//    sandboxed-preload loader, which is CommonJS-only regardless of `sandbox`/package "type" —
//    the observed failure was `"Unable to load preload script: .../dist/tray/preload.js" /
//    "SyntaxError: Cannot use import statement outside a module"`, which silently leaves
//    `window.tokenelo` undefined and hangs the renderer's boot() (and, in --snapshot mode, the
//    whole process, since it waits forever for a "tokenelo:ready" that never fires). esbuild
//    bundling to CJS (same technique already used for the renderer, step 1) is the fix; `main.js`
//    itself doesn't need this because Electron loads the main process as a normal Node ESM entry
//    point, not through the preload loader.
const preloadOutFile = path.join(root, 'dist/tray/preload.js');
if (existsSync(preloadEntry)) {
  run(path.join(root, 'node_modules/.bin/esbuild'), [
    preloadEntry,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    `--outfile=${preloadOutFile}`,
    '--sourcemap',
  ]);
}
