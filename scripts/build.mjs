import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const distDir = join(root, 'dist');
mkdirSync(distDir, { recursive: true });

// 1. Bundle browser UI into a single self-contained HTML file
const uiResult = await build({
  entryPoints: [join(root, 'src', 'ui', 'app.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
});

const jsBundle = uiResult.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
const css = readFileSync(join(root, 'src', 'ui', 'styles.css'), 'utf-8');
const template = readFileSync(join(root, 'src', 'ui', 'template.html'), 'utf-8');

const html = template
  .replace('/*__INLINE_CSS__*/', () => css)
  .replace('/*__INLINE_JS__*/', () => jsBundle);

writeFileSync(join(distDir, 'app.html'), html, 'utf-8');
console.log(`Built dist/app.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB)`);

// 2. Bundle MCP server into a standalone ESM file (keeping node:* built-ins external)
await build({
  entryPoints: [join(root, 'src', 'server.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  packages: 'bundle',
  external: ['node:*'],
  banner: {
    js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
  },
  outfile: join(distDir, 'server.mjs'),
});

const serverSize = readFileSync(join(distDir, 'server.mjs')).length;
console.log(`Built dist/server.mjs (${(serverSize / 1024).toFixed(1)} KiB)`);
