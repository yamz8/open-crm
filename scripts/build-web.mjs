import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public');
const assets = resolve(outDir, 'assets');

const watch = process.argv.includes('--watch');

await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

const options = {
  entryPoints: [resolve(root, 'src/web/app.ts'), resolve(root, 'src/web/styles.css')],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome110', 'firefox110', 'safari16'],
  outdir: assets,
  entryNames: '[name]',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
  // The web bundle imports .ts paths directly, matching how Node runs the server.
  resolveExtensions: ['.ts', '.js', '.css'],
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/web …');
} else {
  await build(options);
}

await copyFile(resolve(root, 'src/web/index.html'), resolve(outDir, 'index.html'));
console.log(`web UI built to ${outDir}`);
