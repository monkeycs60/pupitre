import { createRequire } from 'node:module';
const require = createRequire(process.env.PW_MODULES || import.meta.url);
const { chromium } = require('playwright');
const [,, scenario = 'title', w = '1280', h = '720', touch = '0'] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, hasTouch: touch === '1', isMobile: touch === '1', deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + (e.stack || e.message).slice(0, 600)));
await page.goto('file://' + process.cwd() + '/dist/local.html');
await page.waitForTimeout(2500);
const shot = (n) => page.screenshot({ path: `shots/${n}.png` });
const ev = (f, a) => page.evaluate(f, a);
const mod = await import('./scenarios.mjs');
try { await mod[scenario]({ page, shot, ev }); } catch (e) { errs.push('SCENARIO: ' + (e.stack || e.message)); }
console.log(errs.length ? errs.slice(0, 25).join('\n') : 'no console errors');
await browser.close();
