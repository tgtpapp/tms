// Mở https://thinhphat.pages.dev (chưa đăng nhập), in lỗi console / lỗi tải tệp và chữ đầu trang. Không đăng nhập, không ghi gì.
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 500)); });
p.on('pageerror', (e) => console.log('PAGEERROR', String(e.stack || e).slice(0, 1500)));
p.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText));
p.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
await p.goto('https://thinhphat.pages.dev/', { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);
console.log('TEXT', (await p.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\s+/g, ' '));
console.log('ROOT', await p.evaluate(() => document.getElementById('root')?.innerHTML.length));
await b.close();
