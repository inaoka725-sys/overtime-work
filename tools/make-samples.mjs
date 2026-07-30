/**
 * 社長・江端さんにお見せする出力見本（残業報告書・旬報）を、実際のアプリから生成する。
 *
 *   npm run samples            既定の出力先（残業報告PRJ/出力見本/）へ
 *   npm run samples -- <dir>   出力先を指定
 *
 * 帳票の書式を変更したら、これを再実行して見本を作り直す。
 * サンプルは常用・休出・有給・帰社後作業・深夜作業手当を一通り含めてある。
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2]
  || '/mnt/c/Users/acer nitro/Desktop/エーアイテレコム/☆ブルーランプprj/残業報告PRJ/出力見本/';
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };

const base = (name, empNo) => ({
  name, empNo, workType: 'onsite', hasReturnWork: false, returnOrder: '', returnSubject: '',
  returnStart: '', returnEnd: '', accommodation: 0, transportType: '', transportRoute: '',
  transportRoundTrip: false, remarks: '',
});

// 2026年7月 一旬（7/1〜7/10）。常用・休出・有給・帰社後作業・深夜作業手当を一通り含める
const SAMPLE = [
  { ...base('山田 太郎', '1024'), date: '2026-07-01', workCategory: 'regular',
    order: '35120', subject: '神戸市中央区　交換機更新工事', start: '09:00', end: '20:00',
    dailyAllowance: 300, transportAmount: 1200 },
  { ...base('山田 太郎', '1024'), date: '2026-07-02', workCategory: 'regular',
    order: '35121', subject: '芦屋市　構内配線移設および試験調整', start: '09:00', end: '20:00',
    hasReturnWork: true, returnOrder: '35121', returnSubject: '帰社後　試験成績書作成',
    returnStart: '21:00', returnEnd: '23:30', dailyAllowance: 300, transportAmount: 1200 },
  { ...base('山田 太郎', '1024'), date: '2026-07-03', workCategory: 'regular',
    order: '35120', subject: '神戸市中央区　交換機更新工事', start: '08:30', end: '18:00',
    dailyAllowance: 300, transportAmount: 840 },
  { ...base('山田 太郎', '1024'), date: '2026-07-04', workCategory: 'holiday_work',
    order: '35123', subject: '西宮市　停電作業立会', start: '09:00', end: '17:00',
    dailyAllowance: 300, transportAmount: 1200 },
  { ...base('山田 太郎', '1024'), date: '2026-07-06', workCategory: 'paid_leave',
    order: '', subject: '', start: '', end: '', dailyAllowance: 0, transportAmount: 0 },
  { ...base('山田 太郎', '1024'), date: '2026-07-08', workCategory: 'regular',
    order: '35121', subject: '芦屋市　構内配線移設および試験調整', start: '09:00', end: '19:00',
    dailyAllowance: 300, transportAmount: 1200 },
  { ...base('鈴木 一郎', '1057'), date: '2026-07-01', workCategory: 'regular',
    order: '35130', subject: '姫路市　光ケーブル張替', start: '09:00', end: '21:00',
    dailyAllowance: 300, transportAmount: 1500 },
  { ...base('鈴木 一郎', '1057'), date: '2026-07-05', workCategory: 'regular',
    order: '35131', subject: '加古川市　夜間切替作業', start: '16:00', end: '02:00',
    dailyAllowance: 300, transportAmount: 1500 },
  { ...base('鈴木 一郎', '1057'), date: '2026-07-09', workCategory: 'holiday_work',
    order: '35130', subject: '姫路市　光ケーブル張替', start: '09:00', end: '18:00',
    dailyAllowance: 300, transportAmount: 1500 },
];

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = normalize(join(ROOT, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
page.on('dialog', d => { console.log('dialog:', d.message().split('\n')[0]); d.accept(); });
page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => typeof XLSX !== 'undefined' && typeof addEntry === 'function');

// 保存済みデータとして投入し、アプリ本来の計算で残業時間を確定させる
const summary = await page.evaluate((rows) => {
  entries = rows.map((v, i) => {
    const r = calcCombinedOvertime(v);
    return { id: 1000 + i, ...v,
      mainRegular: r.mainRegular, mainLateNight: r.mainLateNight,
      returnRegular: r.returnRegular, returnLateNight: r.returnLateNight,
      regular: r.regular, lateNight: r.lateNight, lateNightAllowance: r.lateNightAllowance };
  });
  saveEntries();
  return entries.map(e => ({ 日付: e.date, 氏名: e.name, 普通: e.regular,
    深夜: e.lateNight, 手当: e.lateNightAllowance }));
}, SAMPLE);
console.table(summary);

await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => typeof XLSX !== 'undefined');

async function grab(setup, fnName) {
  await page.evaluate(setup);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.evaluate(f => window[f](), fnName),
  ]);
  const name = dl.suggestedFilename();
  const dest = join(OUT, '【見本】' + name);
  await dl.saveAs(dest);
  console.log('saved:', dest);
}

await grab(() => {
  document.getElementById('otMonth').value = '2026-07';
  document.getElementById('otJun').value = 'upper';
}, 'exportOvertimeExcel');

await grab(() => {
  document.getElementById('junMonth').value = '2026-07';
  document.getElementById('junSelect').value = 'upper';
}, 'exportExpenseExcel');

await page.evaluate(() => { entries = []; saveEntries(); });
await browser.close();
server.close();
