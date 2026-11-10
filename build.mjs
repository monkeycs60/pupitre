import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
const r = await build({ entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify: process.argv.includes('--min'), write: false, target: 'es2020', legalComments: 'none' });
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const tpl = readFileSync('template.html', 'utf8');
mkdirSync('dist', { recursive: true });
const page = tpl.replace('/*__BUNDLE__*/', () => js);
writeFileSync('dist/jeu-pirate.html', page);
// page de test locale : même contenu, bibliothèque servie en local, squelette proche de celui de la publication
const test = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}html{box-sizing:border-box}body{margin:0;font:14px system-ui}[hidden]{display:none!important}</style></head><body>${page.replace('https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js', 'three.min.js').replace(/<link rel="stylesheet"[^>]*>/, '')}</body></html>`;
writeFileSync('dist/local.html', test);
copyFileSync('node_modules/three/build/three.min.js', 'dist/three.min.js');
console.log('bundle', (js.length / 1024).toFixed(0) + ' KB');
