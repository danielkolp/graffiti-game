import path from 'node:path';
import { build, context } from 'esbuild';

const root = process.cwd();
const entry = path.resolve(root, 'public', 'script.js');
const outfile = path.resolve(root, 'public', 'dist', 'app.js');
const watchMode = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info'
};

if (!watchMode) {
  await build(buildOptions);
} else {
  const buildContext = await context(buildOptions);
  await buildContext.watch();
  console.log('Watching client bundle for changes...');
}
