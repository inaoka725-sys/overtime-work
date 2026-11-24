/**
 * 旬報アプリ 計算ロジックの回帰テスト。
 *
 * index.html は単一HTMLで外部依存を持たないため、実ブラウザで本物のページを読み込み、
 * 公開されている計算関数をそのまま呼んで規程どおりの値になるかを検証する。
 * （スタブを置かないので、DOM構成が変わってもテスト側の保守が要らない）
 *
 * 規程: overtime/docs/requirements.md
 *   残業開始（常用）= 勤務開始 + 570分 ／（休出）= 勤務開始
 *   休憩帯7種: 08:30-09:00 12:00-13:00 15:00-15:30 18:00-18:30 22:00-22:30 02:00-03:00 06:00-06:30
 *   普通残業 = 残業帯 ∩ [6:00,22:00] ／ 深夜残業 = 残業帯 ∩ [22:00,翌6:00]（いずれも休憩控除）
 *   集計は0.5時間単位（四捨五入）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };

let server, browser, page;
const consoleErrors = [];

before(async () => {
  server = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = normalize(join(ROOT, rel === '/' ? 'index.html' : rel));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('dialog', d => d.accept());
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
  // XLSX は Excel 出力に必須。CDN が引けない場合はここで落として原因を明示する
  await page.waitForFunction(() => typeof calcOvertime === 'function' && typeof XLSX !== 'undefined',
    null, { timeout: 30000 });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** ブラウザ側で式を評価する（第2引数はページへ渡す値） */
const evalIn = (fn, arg) => page.evaluate(fn, arg);

// ===== 残業開始時刻 =====

test('残業開始時刻は 常用=勤務開始+9時間30分、休出=勤務開始', async () => {
  const got = await evalIn(() => [
    ['09:00', false], ['08:00', false], ['12:00', false], ['09:00', true],
  ].map(([s, h]) => minToTimeStr(calcOvertime(s, '23:59', h).overtimeStart)));
  assert.deepEqual(got, ['18:30', '17:30', '21:30', '09:00']);
});

// ===== 休憩控除と普通／深夜の切り分け =====

test('常用 9:00-23:00 は 普通3.5H・深夜0.5H（22:00-22:30の休憩を控除）', async () => {
  const r = await evalIn(() => calcOvertime('09:00', '23:00', false));
  assert.equal(r.regular, 3.5);
  assert.equal(r.lateNight, 0.5);
});

test('休出 9:00-18:00 は全時間が残業対象で 7.5H（昼休憩と15時休憩を控除）', async () => {
  const r = await evalIn(() => calcOvertime('09:00', '18:00', true));
  assert.equal(r.regular, 7.5);
  assert.equal(r.lateNight, 0);
});

// ===== 帰社後作業（2026/05/27 に発生し 07/30 に修正した過大計上の回帰） =====

test('常用の帰社後作業は帰社後の開始時刻を残業起点にする（本作業9:00-20:00＋帰社後21:00-23:30 → 普通2.5H）',
  async () => {
    const r = await evalIn(() => calcCombinedOvertime({
      workCategory: 'regular', start: '09:00', end: '20:00',
      hasReturnWork: true, returnStart: '21:00', returnEnd: '23:30',
    }));
    assert.equal(r.mainRegular, 1.5, '本作業 18:30-20:00');
    assert.equal(r.returnRegular, 1.0, '帰社後 21:00-22:00');
    assert.equal(r.returnLateNight, 1.0, '帰社後 22:00-23:30 から休憩30分を控除');
    assert.equal(r.regular, 2.5, '修正前は 5.0H（20:00-21:00 の未就業時間を算入していた）');
    assert.equal(r.lateNight, 1.0);
  });

test('残業起点は規程の起点を下回らせない（本作業12:00-21:00＋帰社後21:00-23:00 → 起点21:30）', async () => {
  const r = await evalIn(() => calcCombinedOvertime({
    workCategory: 'regular', start: '12:00', end: '21:00',
    hasReturnWork: true, returnStart: '21:00', returnEnd: '23:00',
  }));
  assert.equal(r.mainRegular, 0, '勤務終了が起点21:30より前なので残業なし');
  assert.equal(r.regular, 0.5, '帰社後 21:30-22:00');
  assert.equal(r.lateNight, 0.5, '帰社後 22:00-23:00 から休憩30分を控除');
});

test('休出の帰社後作業は帰社後自身の開始時刻が起点（2026/06/13 の修正の回帰）', async () => {
  const r = await evalIn(() => calcCombinedOvertime({
    workCategory: 'holiday_work', start: '09:00', end: '18:00',
    hasReturnWork: true, returnStart: '20:00', returnEnd: '22:00',
  }));
  assert.equal(r.regular, 9.5, '本作業7.5H ＋ 帰社後2.0H');
  assert.equal(r.lateNight, 0);
});

// ===== 深夜作業手当 =====

test('深夜作業手当は常用で18:00-翌6:00の在籍が5時間以上のとき一律3,000円', async () => {
  const got = await evalIn(() => ({
    常用16時始まり: calcLateNightWorkAllowance('16:00', '02:00', false),
    常用9時始まり: calcLateNightWorkAllowance('09:00', '23:00', false),
    休出16時始まり: calcLateNightWorkAllowance('16:00', '02:00', true),
    常用0時始まり: calcLateNightWorkAllowance('00:00', '09:30', false),
  }));
  assert.equal(got.常用16時始まり, 3000);
  assert.equal(got.常用9時始まり, 0);
  assert.equal(got.休出16時始まり, 0, '休出は常に0');
  assert.equal(got.常用0時始まり, 3000, '0:00-6:00 の5時間（2:00-3:00休憩控除）も数える');
});

test('深夜作業手当は実際の勤務時間だけで判定する（常用 20:00-22:00 の短時間勤務には付かない）', async () => {
  const got = await evalIn(() => [
    ['20:00', '22:00'], ['18:00', '23:30'], ['18:00', '00:00'], ['16:00', '22:00'],
  ].map(([s, e]) => calcLateNightWorkAllowance(s, e, false)));
  assert.deepEqual(got, [0, 0, 3000, 0], '18:00-24:00 は休憩2回(各30分)を引いて丁度5時間、23:30終了は4.5時間');
});

// ===== 開始日の 0:00〜6:00（深夜帯の取りこぼし） =====

test('休出の 0:00〜6:00 は深夜残業に数える', async () => {
  const got = await evalIn(() => ({
    休出4時から8時: calcOvertime('04:00', '08:00', true),
    休出0時から6時: calcOvertime('00:00', '06:00', true),
  }));
  assert.equal(got.休出4時から8時.lateNight, 2.0, '4:00-6:00');
  assert.equal(got.休出4時から8時.regular, 1.5, '6:00-8:00 から 6:00-6:30 の休憩を控除');
  assert.equal(got.休出0時から6時.lateNight, 5.0, '2:00-3:00 の休憩を控除');
  assert.equal(got.休出0時から6時.regular, 0);
});

// ===== 0時をまたぐ帰社後作業（本作業と同じ時間軸で扱う） =====

const RETURN_CASES = [
  // [区分, 本作業, 帰社後, 期待する帰社後の普通H, 深夜H]
  ['regular', '09:00', '01:00', '01:30', '03:00', 0, 0.5],
  ['regular', '21:00', '07:00', '08:00', '10:00', 1.5, 0],
  ['holiday_work', '08:00', '01:00', '01:30', '04:00', 0, 1.5],
  ['regular', '09:00', '23:00', '00:00', '02:00', 0, 2.0],
];

test('帰社後作業が0時をまたいで翌日になっても残業を計上する', async () => {
  const got = await evalIn((cases) => cases.map(([workCategory, start, end, returnStart, returnEnd]) => {
    const r = calcCombinedOvertime({ workCategory, start, end, hasReturnWork: true, returnStart, returnEnd });
    return [r.returnRegular, r.returnLateNight];
  }), RETURN_CASES);
  assert.deepEqual(got, RETURN_CASES.map(c => [c[5], c[6]]));
});

// ===== 旬の判定 =====

test('旬は 1〜10日=一旬 / 11〜20日=二旬 / 21〜末日=三旬', async () => {
  const got = await evalIn(() => ['2026-06-01', '2026-06-10', '2026-06-11', '2026-06-20',
    '2026-06-21', '2026-06-30', '2026-02-28'].map(getJun));
  assert.deepEqual(got, ['upper', 'upper', 'mid', 'mid', 'lower', 'lower', 'lower']);
});

// ===== 旅費の小計（宿泊費の扱い） =====

test('旬報Excelの小計は宿泊費を含めず、画面の小計は含める', async () => {
  const got = await evalIn(() => {
    const e = { dailyAllowance: 300, transportAmount: 500, accommodation: 9000 };
    return { junpo: junpoSubtotal(e), screen: expenseSubtotal(e) };
  });
  assert.equal(got.junpo, 800, '印字項目（日当・交通費）の横計と一致させる');
  assert.equal(got.screen, 9800, '入力確認用なので宿泊費も含む');
});

// ===== 旬報Excel（区分欄＝日数、明細と合計の整合） =====

const JUNPO_ROWS = [
  ['2026-06-01', 'regular', '111'], ['2026-06-01', 'regular', '222'],
  ['2026-06-02', 'regular', '333'], ['2026-06-03', 'holiday_work', '444'],
  ['2026-06-03', 'holiday_work', '555'], ['2026-06-04', 'paid_leave', ''],
  ['2026-06-05', 'regular', ''],
];

/** テスト用エントリーを組み立てる（日当300円・交通費500円） */
function junpoFixture() {
  return JUNPO_ROWS.map(([date, workCategory, order]) => ({
    date, workCategory, order, name: 'テスト', empNo: '001', subject: '件名' + order,
    workType: 'onsite', start: '09:00', end: '18:00', hasReturnWork: false,
    returnStart: '', returnEnd: '', mainRegular: 0, mainLateNight: 0, returnRegular: 0,
    returnLateNight: 0, regular: 0, lateNight: 0, lateNightAllowance: 0,
    dailyAllowance: workCategory === 'paid_leave' ? 0 : 300,
    transportAmount: workCategory === 'paid_leave' ? 0 : 500,
    accommodation: 0, transportType: '', transportRoute: '', transportRoundTrip: false, remarks: '',
  }));
}

test('旬報の区分欄は日数で、明細列の合計と合計行が一致する（同日を午前・午後に分けても1日）', async () => {
  const got = await evalIn((rows) => {
    const ws = buildJunpoSheet(rows, 2026, 6, 'upper', 'テスト');
    const cell = a => (ws[a] && ws[a].v !== undefined ? ws[a].v : '');
    const tr = 8 + Math.max(15, rows.length) + 1;
    const colSum = c => {
      let s = 0;
      for (let i = 0; i < Math.max(15, rows.length); i++) {
        const v = cell(c + (9 + i));
        if (typeof v === 'number') s += v;
      }
      return s;
    };
    const cols = { 常用: 'D', 休出: 'E', 有給: 'F', 代休: 'G', 日当: 'J', 交通費: 'K', 小計: 'L' };
    const total = {}, sum = {};
    for (const [k, c] of Object.entries(cols)) { total[k] = cell(c + tr) || 0; sum[k] = colSum(c); }
    return { total, sum, 一件目: cell('D9'), 二件目: cell('D10') };
  }, junpoFixture());

  assert.equal(got.一件目, 1, '6/1 の1件目には 1 を立てる');
  assert.equal(got.二件目, '', '同じ6/1の2件目は空欄（列の合計を日数に保つ）');
  assert.equal(got.total.常用, 3, '6/1・6/2・6/5 の3日');
  assert.equal(got.total.休出, 1, '6/3 の1日（2件あっても1日）');
  assert.equal(got.total.有給, 1);
  assert.equal(got.total.代休, 0);
  assert.deepEqual(got.sum, got.total, '明細列の合計と合計行が一致しないと経理の突合が合わない');
});

test('オーダ別集計の金額計は明細の小計合計と一致し、オーダー番号が空でも計上する', async () => {
  const got = await evalIn((rows) => {
    const agg = junpoOrderAgg(rows);
    return {
      明細合計: rows.reduce((s, e) => s + junpoSubtotal(e), 0),
      オーダ別合計: agg.reduce((s, o) => s + o.amount, 0),
      オーダーなしの件数: agg.filter(o => o.order === NO_ORDER_LABEL).length,
      日数: agg.map(o => o.days),
    };
  }, junpoFixture());

  assert.equal(got.明細合計 - got.オーダ別合計, 0, '差異が出ると経理の突合が合わない');
  assert.equal(got.オーダーなしの件数, 1, 'オーダー番号が空でも金額があれば計上する');
  assert.ok(got.日数.every(d => d === 1));
});

// ===== 保存済みデータの再計算 =====

test('保存済みの古い残業時間を起動時に再計算し、冪等で、時刻が欠けた行は触らない', async () => {
  const got = await evalIn(() => {
    const base = {
      name: 'テスト', empNo: '001', order: '111', subject: '件名', workCategory: 'regular',
      workType: 'onsite', hasReturnWork: false, returnStart: '', returnEnd: '',
      mainLateNight: 0, returnRegular: 0, returnLateNight: 0, lateNightAllowance: 0,
      dailyAllowance: 0, accommodation: 0, transportType: '', transportRoute: '',
      transportAmount: 0, transportRoundTrip: false, remarks: '',
    };
    entries = [
      { ...base, id: 1, date: '2026-06-01', start: '09:00', end: '20:00', hasReturnWork: true,
        returnStart: '21:00', returnEnd: '23:30', mainRegular: 1.5, returnRegular: 3.5,
        regular: 5.0, lateNight: 1.0 },
      { ...base, id: 2, date: '2026-06-02', start: '09:00', end: '20:00',
        mainRegular: 1.5, regular: 1.5, lateNight: 0 },
      { ...base, id: 3, date: '2026-06-03', start: '', end: '', mainRegular: 0, regular: 0, lateNight: 0 },
    ];
    let notified = 0;
    const orig = window.alert;
    window.alert = () => { notified++; };
    recalcStoredOvertime();
    const after1 = entries.map(e => ({ id: e.id, regular: e.regular, lateNight: e.lateNight }));
    recalcStoredOvertime();
    const after2 = entries.map(e => ({ id: e.id, regular: e.regular, lateNight: e.lateNight }));
    window.alert = orig;
    entries = [];
    saveEntries();
    return { notified, after1, after2 };
  });

  assert.equal(got.notified, 1, '差分があった1回だけ通知し、2回目は通知しない');
  assert.deepEqual(got.after1[0], { id: 1, regular: 2.5, lateNight: 1 }, '5.0H → 2.5H に修正');
  assert.deepEqual(got.after1[1], { id: 2, regular: 1.5, lateNight: 0 }, '正しい値は変更しない');
  assert.deepEqual(got.after1[2], { id: 3, regular: 0, lateNight: 0 },
    '時刻が欠けた行は空文字が0:00と解釈されて過大値になるため再計算しない');
  assert.deepEqual(got.after2, got.after1, '再実行しても値が変わらない（冪等）');
});

// ===== 画面操作（入力チェック・旬報タブ・表示のエスケープ） =====

/** テスト間で状態を持ち越さないよう、作業データを空にして画面を描き直す */
const resetEntries = () => evalIn(() => {
  cancelEdit(); entries = []; saveEntries(); renderEntries(); updateSummary();
});

/** 入力フォームへ値を入れて「追加」を押し、出た alert の文言を返す */
async function submitForm(f) {
  await page.click('.tab-btn:has-text("残業報告書")');
  await page.fill('#inputDate', f.date);
  await page.fill('#inputName', f.name);
  await page.fill('#inputSubject', f.subject || '');
  await page.selectOption('#inputStart', f.start);
  await page.selectOption('#inputEnd', f.end);
  if (f.returnStart) {
    await page.check('#hasReturnWork');
    await page.selectOption('#inputReturnStart', f.returnStart);
    await page.selectOption('#inputReturnEnd', f.returnEnd);
  }
  await page.fill('#inputDailyAllowance', String(f.dailyAllowance ?? 0));
  await evalIn(() => { window.__alerts = []; window.alert = m => window.__alerts.push(m); });
  await page.click('#addEntryBtn');
  return evalIn(() => window.__alerts);
}

test('入力チェック: 開始=終了・マイナス金額を拒否し、0時をまたぐ帰社後作業は受け付ける。氏名は前後の空白を除く',
  async () => {
    await resetEntries();
    const base = { date: '2026-06-05', name: '  テスト太郎 ', start: '09:00', end: '23:00' };
    const same = await submitForm({ ...base, start: '09:00', end: '09:00' });
    const minus = await submitForm({ ...base, dailyAllowance: -300 });
    const before = await submitForm({ ...base, end: '20:00', returnStart: '19:00', returnEnd: '21:00' });
    const ok = await submitForm({ ...base, returnStart: '00:00', returnEnd: '02:00' });
    const saved = await evalIn(() => entries.map(e => ({ name: e.name, lateNight: e.returnLateNight })));
    await resetEntries();
    assert.equal(same.length, 1, '開始=終了は24時間勤務として計算されるため拒否');
    assert.equal(minus.length, 1, '日当のマイナスは拒否');
    assert.match(before[0] || '', /帰社後の開始時間/, '作業終了より前の帰社後開始は拒否');
    assert.deepEqual(ok, [], '翌0:00からの帰社後作業は受け付ける');
    assert.deepEqual(saved, [{ name: 'テスト太郎', lateNight: 2 }]);
  });

test('旬報タブは作業の追加・削除に追随する（削除した行が残らない）', async () => {
  await resetEntries();
  await submitForm({ date: '2026-06-05', name: 'テスト', subject: '旬報追随テスト', start: '09:00', end: '20:00' });
  await page.click('.tab-btn:has-text("旬報")');
  await page.fill('#junMonth', '2026-06');
  await page.dispatchEvent('#junMonth', 'change');
  await page.selectOption('#junSelect', 'all');
  const rowsAfterAdd = await page.locator('#expenseContent .expense-table').first().locator('tbody tr').count();
  await page.click('.tab-btn:has-text("残業報告書")');
  await page.click('#entriesList .btn-danger');
  await page.click('.tab-btn:has-text("旬報")');
  const afterDelete = await page.textContent('#expenseContent');
  await resetEntries();
  assert.equal(rowsAfterAdd, 1);
  assert.match(afterDelete, /該当するデータがありません/);
  assert.doesNotMatch(afterDelete, /旬報追随テスト/);
});

test('編集中の行を削除すると編集モードを解除する（「更新する」で黙って消えない）', async () => {
  await resetEntries();
  await submitForm({ date: '2026-06-05', name: 'テスト', start: '09:00', end: '20:00' });
  const got = await evalIn(() => {
    const id = entries[0].id;
    editEntry(id);
    deleteEntry(id);
    return { editingId, button: document.getElementById('addEntryBtn').textContent };
  });
  await resetEntries();
  assert.deepEqual(got, { editingId: null, button: 'この内容を追加' });
});

test('件名などの記号はそのまま表示し、HTMLとして解釈しない（XSS対策）', async () => {
  await resetEntries();
  const subject = '配管工事<第2期> & A<B';
  await submitForm({ date: '2026-06-05', name: 'テスト', subject, start: '09:00', end: '20:00' });
  const got = await evalIn(() => {
    const saved = orderMaster;
    orderMaster = { 'A"1': { subject: '<img src=x onerror="window.__xss=1">', assignee: '', allowance: 0 } };
    renderOrderMaster();
    const master = document.getElementById('orderMasterList');
    const res = { masterText: master.textContent, img: master.querySelectorAll('img').length };
    master.querySelector('button[data-order]').click();   // 「"」を含むオーダー番号でも削除できる
    res.left = Object.keys(orderMaster).length;
    orderMaster = saved;
    saveOrderMaster();
    renderOrderMaster();
    return { ...res, list: document.getElementById('entriesList').textContent,
      expense: document.getElementById('expenseContent').textContent };
  });
  await resetEntries();
  assert.ok(got.list.includes(subject), '登録一覧で件名が欠けない');
  assert.ok(got.expense.includes(subject), '旬報タブで件名が欠けない');
  assert.equal(got.img, 0, 'マスター件名の <img> がタグとして生成されない');
  assert.ok(got.masterText.includes('<img src=x'));
  assert.equal(got.left, 0, '「"」入りのオーダー番号も削除できる');
});

test('不正なバックアップは理由を示して復元を中止し、既存データを壊さない', async () => {
  await resetEntries();
  await submitForm({ date: '2026-06-05', name: '既存', start: '09:00', end: '20:00' });
  const bad = JSON.stringify({ format: 'overtime-backup', version: 1, entries: [{ name: 'x' }] });
  await page.click('.tab-btn:has-text("設定")');
  await page.setInputFiles('#backupFile', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
  await page.waitForFunction(() => document.getElementById('backupStatus').style.display === 'block');
  const got = await evalIn(() => ({
    status: document.getElementById('backupStatus').textContent,
    stored: JSON.parse(localStorage.getItem(STORAGE_KEY)).map(e => e.name),
    validOk: (() => { try { parseBackup(JSON.stringify({ format: 'overtime-backup', version: 1,
      entries, settings: { name: 'a' } })); return true; } catch (e) { return e.message; } })(),
    dupId: (() => { try { parseBackup(JSON.stringify({ format: 'overtime-backup', version: 1,
      entries: [entries[0], entries[0]] })); return ''; } catch (e) { return e.message; } })(),
  }));
  await resetEntries();
  assert.match(got.status, /1 件目/);
  assert.deepEqual(got.stored, ['既存'], '不正なファイルでは置き換えない');
  assert.equal(got.validOk, true, 'このアプリが書き出した形式は通る');
  assert.match(got.dupId, /2 件目.*重複/);
});

// ===== 翌日扱いの帰社後作業の確認 =====

/** confirm の応答を固定して submitForm し、出た confirm の文言と登録結果を返す */
async function submitWithConfirm(f, answer) {
  await resetEntries();
  await evalIn((a) => { window.__confirms = []; window.confirm = m => { window.__confirms.push(m); return a; }; },
    answer);
  const alerts = await submitForm(f);
  return evalIn((al) => ({
    alerts: al, confirms: window.__confirms,
    saved: entries.map(e => [e.returnRegular, e.returnLateNight]),
  }), alerts);
}

test('翌日扱いで本作業終了から6時間を超えてあく帰社後作業は確認し、キャンセルなら登録しない', async () => {
  const far = { date: '2026-06-05', name: 'テスト', start: '09:00', end: '20:00', returnStart: '08:00',
    returnEnd: '10:00' };
  const rejected = await submitWithConfirm(far, false);
  const note = await evalIn(() => { updatePreview(); return document.getElementById('resultReturnNote').textContent; });
  const accepted = await submitWithConfirm(far, true);
  await resetEntries();
  assert.equal(rejected.confirms.length, 1);
  assert.match(rejected.confirms[0], /翌日の08:00〜10:00として登録しますか/);
  assert.deepEqual(rejected.saved, [], 'キャンセルなら登録しない');
  assert.match(note, /翌日の 08:00〜10:00 として計算/, 'プレビューでも翌日扱いと分かる');
  assert.equal(accepted.confirms.length, 1);
  assert.deepEqual(accepted.saved, [[1.5, 0]], '受諾なら翌日 8:00-10:00（8:30-9:00休憩控除）で登録');
});

test('本作業終了から6時間以内の翌日の帰社後作業は確認なしで登録する', async () => {
  const cases = [['09:00', '23:00', '00:00', '02:00'], ['09:00', '01:00', '01:30', '03:00']];
  const got = [];
  for (const [start, end, returnStart, returnEnd] of cases) {
    got.push(await submitWithConfirm({ date: '2026-06-05', name: 'テスト', start, end, returnStart, returnEnd },
      false));
  }
  await resetEntries();
  assert.deepEqual(got.map(g => g.confirms), [[], []]);
  assert.deepEqual(got.map(g => g.saved), [[[0, 2]], [[0, 0.5]]]);
});

// ===== 初期版（workCategory 無し・dayType のみ）のデータ =====

/** 初期版 cf04ebd が保存していた形のエントリー */
const legacyEntry = (id, dayType, start, end, regular, lateNight) => ({
  id, date: `2026-04-0${id}`, name: '旧データ', order: '', subject: '', workType: 'onsite', dayType, start, end,
  hasReturnWork: false, returnOrder: '', returnSubject: '', returnStart: '20:00', returnEnd: '22:00',
  mainRegular: regular, mainLateNight: lateNight, returnRegular: 0, returnLateNight: 0,
  regular, lateNight, lateNightAllowance: 0,
});

test('初期版のデータ（dayType のみ）を起動時の再計算で残業0に潰さない', async () => {
  const got = await evalIn((rows) => {
    entries = rows;
    let notified = 0;
    const orig = window.alert;
    window.alert = () => { notified++; };
    recalcStoredOvertime();
    window.alert = orig;
    const res = { notified, vals: entries.map(e => [e.regular, e.lateNight]) };
    editEntry(2);
    res.editCat = document.querySelector('input[name="workCategory"]:checked').value;
    cancelEdit();
    return res;
  }, [legacyEntry(1, 'weekday', '09:15', '23:00', 3.5, 0.5), legacyEntry(2, 'holiday', '09:00', '18:00', 7.5, 0)]);
  await resetEntries();
  assert.deepEqual(got.vals, [[3.5, 0.5], [7.5, 0]], '平日=常用、休日=休出として計算し、正しい保存値はそのまま');
  assert.equal(got.notified, 0, '差分が無いので通知しない');
  assert.equal(got.editCat, 'holiday_work', '編集時も休日は休出として開く');
});

test('バックアップの復元直後に古い残業時間を現在の計算ロジックで正す', async () => {
  await resetEntries();
  const stale = { ...legacyEntry(1, 'weekday', '09:00', '20:00', 1.5, 0), workCategory: 'regular',
    hasReturnWork: true, returnStart: '21:00', returnEnd: '23:30', returnRegular: 3.5, regular: 5.0, lateNight: 1.0 };
  const file = JSON.stringify({ format: 'overtime-backup', version: 1, entries: [stale] });
  await evalIn(() => {
    window.__alerts = []; window.alert = m => window.__alerts.push(m); window.confirm = () => true;
  });
  await page.click('.tab-btn:has-text("設定")');
  await page.setInputFiles('#backupFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await page.waitForFunction(() => /件を復元しました/.test(document.getElementById('backupStatus').textContent));
  const got = await evalIn(() => ({
    alerts: window.__alerts,
    stored: JSON.parse(localStorage.getItem(STORAGE_KEY)).map(e => [e.regular, e.lateNight]),
  }));
  await resetEntries();
  assert.deepEqual(got.stored, [[2.5, 1]], '5.0H → 2.5H に直して保存');
  assert.equal(got.alerts.length, 1);
  assert.match(got.alerts[0], /1件を正しい値に直しました/);
});

// ===== 読み込み時の健全性 =====

test('ページ読み込みでコンソールエラーが出ない', () => {
  const real = consoleErrors.filter(m => !/favicon\.ico/.test(m));
  assert.deepEqual(real, []);
});
