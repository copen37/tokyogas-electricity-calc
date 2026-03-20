# tokyogas-electricity-calc

東京ガス（東京電力エリア）向けの電気料金比較ツール。
Python版資産を `output/` に保存しつつ、Next.js（ブラウザ完結）でUIを提供します。

## 目的
- 契約条件・月次単価を入れて、プランごとの概算電気料金を比較する
- ガスセット有無（both/with/without）を切り替えて比較する
- 時間帯別プラン（jikanbetsu）を昼/夜kWhで正確に計算する

## 使い方（Next.js）
```bash
pnpm install
pnpm dev
# http://localhost:3000
```

## GitHub Pages 公開URL
- https://copen37.github.io/tokyogas-electricity-calc/

## 入力機能

### 1) 契約条件
- 契約タイプ: `A(アンペア) / kVA / kW`
- 選択した契約タイプに応じて入力欄を切替
- 比較結果には、契約条件に適用可能なプランのみ表示

### 2) 使用量入力
- **総kWh入力モード**（従来）
  - `jikanbetsu` は平均単価 fallback で計算
- **時間帯別入力モード**（追加）
  - 昼 kWh（06:00-01:00）
  - 夜 kWh（01:00-06:00）
  - `jikanbetsu` は昼/夜単価で正確に計算

### 3) CSV/ZIPアップロード（ブラウザ内処理）
ヘッダは `timestamp,power`（または `計測日時,買電`）。

```csv
timestamp,power
2026-04-01T00:00:00+09:00,420
2026-04-01T00:30:00+09:00,390
2026-04-01T01:00:00+09:00,360
```

- power-unit: `W / kW / Wh / kWh`
- **複数CSV同時アップロード**に対応
- **ZIPアップロード**に対応（ZIP内CSVを一括展開して集計）
- `W/kW` の場合は、隣接時刻差分から `dt-minutes` を自動推定
- timestamp に offset があればそれを尊重
- offset が無い timestamp は `Asia/Tokyo` とみなす
- 読み込み後に月ごとの `total_kWh / day_kWh / night_kWh` を表示
- 「この月を入力へ反映」で年月・昼夜kWhをフォームに反映し、そのまま比較可能
- **期間指定集計（開始日〜終了日）**で total/day/night を算出し「期間集計を入力へ反映」可能
- 「アップロード内容をクリア」で読み込んだCSV/ZIPと集計結果を初期化

> 安定性のため、CSVは最大20万行まで読み込み（超過分は切り捨て）

## 操作手順（Pages上）
1. 公開URLを開く
2. 契約タイプと契約値を選択
3. CSV/ZIPをアップロード（power-unitを選択、複数選択可）
4. 月次集計の「この月を入力へ反映」または期間指定集計の「期間集計を入力へ反映」を押す
5. 必要なら「アップロード内容をクリア」で再読み込み
6. 「実行」で比較結果を確認

## GitHub Pages デプロイ方法
このリポジトリは Next.js を静的エクスポート（`output: 'export'`）して、GitHub Actions で Pages にデプロイします。

1. `main` ブランチへ push
2. `.github/workflows/deploy.yml` が起動
3. `pnpm build` で `out/` を生成
4. `out/` を Pages artifact としてアップロード
5. `actions/deploy-pages` で公開

初回のみ（または未設定時）は、Pages のソースを **GitHub Actions** に設定してください。

```bash
gh api --method POST repos/copen37/tokyogas-electricity-calc/pages \
  -f build_type=workflow
```

## 変動単価更新の注意
- 月次更新: `output/unit_prices_template.json` の `monthly_adjustments[YYYY-MM]`
  - `fuel_adjustment_yen_per_kwh`
  - `gov_support_yen_per_kwh`
- 年次更新: `annual_levies[FYxxxx].renewable_surcharge_yen_per_kwh`
- 計算結果は円未満切り捨て（floor）

## 構成
- `output/`: 元のPython実装・計算定義・調査メモ
- `app/`, `lib/`: Next.jsブラウザ版（TypeScript）
