import { build } from 'esbuild';
await build({ entryPoints: ['src/background.ts'], bundle: true, format: 'esm', outfile: 'dist/background.js', target: 'chrome110' });
await build({ entryPoints: ['src/content.ts'], bundle: true, format: 'iife', outfile: 'dist/content.js', target: 'chrome110' });
console.log('background.js + content.js built');
