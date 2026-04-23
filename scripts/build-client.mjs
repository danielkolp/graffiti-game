import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const entry = path.resolve(root, 'public', 'script.js');
const outfile = path.resolve(root, 'public', 'dist', 'app.js');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info'
});
