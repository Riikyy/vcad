/* Build script for the three bundles this extension ships:
 *   - dist/extension.js   CJS, runs in the VS Code extension host
 *   - dist/parseWorker.mjs ESM, runs in a worker_thread (libredwg-web is ESM-only)
 *   - dist/webview.js     IIFE, runs in the webview
 */
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build failures with file/line so `npm run watch` is usable. */
const problemMatcher = {
  name: 'problem-matcher',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}`);
      }
      if (result.errors.length === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] build finished`);
      }
    });
  },
};

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [problemMatcher],
};

const configs = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    // `vscode` is provided by the host at runtime and must never be bundled.
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/parser/worker.ts'],
    outfile: 'dist/parseWorker.mjs',
    format: 'esm',
    platform: 'node',
    target: 'node18',
    // libredwg-web is ESM + a 10 MB sidecar .wasm; keep it external and resolve
    // it from node_modules at runtime so the .wasm stays next to its glue code.
    external: ['@mlightcad/libredwg-web'],
  },
  {
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2021',
  },
];

async function main() {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching…');
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
