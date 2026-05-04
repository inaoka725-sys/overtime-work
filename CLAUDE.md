# 時間外・旅費精算書アプリ

## 基本原則
> 「シンプルさは究極の洗練である」

- **最小性**: 不要なコードは一文字も残さない。必要最小限を超えない
- **単一性**: 真実の源は常に一つ（要件: overtime/docs/requirements.md、進捗: overtime/docs/SCOPE_PROGRESS.md）
- **実証性**: 推測しない。規程（時間外手当基準）を必ず参照して計算ロジックを検証する
- **潔癖性**: エラーは隠さない

## プロジェクト設定

```yaml
アーキテクチャ: 単一HTMLファイル（サーバーレス）
ファイル構成:
  overtime/
    - index.html          # メインアプリ（HTML+CSS+JS 一体、3タブ構成）
    - manual.html         # 操作マニュアル
    - docs/
        - requirements.md     # 要件定義書
        - SCOPE_PROGRESS.md   # 実装進捗
外部ライブラリ:
  - SheetJS (xlsx-latest) via CDN — Excel出力専用
ホスティング: GitHub Pages（https://inaoka725-sys.github.io/overtime-work/）
```

## 規程の重要ルール（計算ロジックに関わる）

```
残業開始（平日）: 勤務開始 + 570分（9時間30分） ← 絶対に変えない
残業開始（休日）: 勤務開始から全時間

休憩帯（7種）:
  08:30-09:00 / 12:00-13:00 / 15:00-15:30 / 18:00-18:30
  22:00-22:30 / 02:00-03:00 / 06:00-06:30

時間外手当:
  普通残業: 残業 ∩ [6:00-22:00] の実働時間（H）
  深夜残業: 残業 ∩ [22:00-翌6:00] の実働時間（H）
  深夜作業手当: 常用勤務が18:00-翌6:00に5h以上 → 一律3,000円（平日のみ）
  ※深夜作業手当と時間外作業手当は同一時間帯で重複不可

時間集計: 0.5時間単位（四捨五入）
```

## コード品質

- 関数: 100行以下 / ファイル: 1000行以下 / 行長: 120文字
- 計算ロジックの変更は必ず `overtime/docs/requirements.md` の規程ルールと照合すること

## 開発ルール

### 計算ロジックの修正
- `calcOvertime()`: 残業時間計算のコア関数。変更時は複数の開始時間でテストすること
  - 9:00始まり → 残業開始18:30（平日）
  - 8:00始まり → 残業開始17:30（平日）
  - 12:00始まり → 残業開始21:30（平日）
- `calcLateNightWorkAllowance()`: 深夜作業手当計算。休日は常に0を返す

### Excel出力
- SheetJS の `XLSX.utils.aoa_to_sheet` を使用
- シート構成: 個人別報告書（名前ごと）＋ 一覧シート
- 令和年号: `getFullYear() - 2018`

### UIの更新
- 計算結果はリアルタイムで `updatePreview()` が更新する
- エントリー追加: `addEntry()` → `renderEntries()` → `updateSummary()`

## Playwright

スクリーンショット保存先: /tmp/bluelamp-screenshots/

## ドキュメント管理

許可されたドキュメントのみ作成可能:
- overtime/docs/requirements.md（要件定義）
- overtime/docs/SCOPE_PROGRESS.md（実装計画・進捗）
上記以外のドキュメント作成はユーザー許諾が必要。
