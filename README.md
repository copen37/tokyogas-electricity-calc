# tokyogas-electricity-calc

東京ガス（東京電力エリア）向けの電気料金比較ツール。
Python版資産を `output/` に保存しつつ、Next.js（ブラウザ完結）で最小UIを提供します。

## 目的
- 契約条件・月次単価を入れて、プランごとの概算電気料金を比較する
- ガスセット有無（both/with/without）を切り替えて比較する

## 使い方（Next.js）
```bash
pnpm install
pnpm dev
# http://localhost:3000
```

## GitHub Pages 公開URL
- https://copen37.github.io/tokyogas-electricity-calc/

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

> private リポジトリのまま Pages を使えるかどうかは、GitHub プランに依存します（Free だと制限される場合があります）。

画面入力:
- 契約A
- 年月(YYYY-MM)
- 使用量kWh
- ガス有無(both/with/without)

## 変動単価更新の注意
- 月次更新: `output/unit_prices_template.json` の `monthly_adjustments[YYYY-MM]`
  - `fuel_adjustment_yen_per_kwh`
  - `gov_support_yen_per_kwh`
- 年次更新: `annual_levies[FYxxxx].renewable_surcharge_yen_per_kwh`
- 計算結果は円未満切り捨て（floor）

## 構成
- `output/`: 元のPython実装・計算定義・調査メモ
- `app/`, `lib/`: Next.jsブラウザ版（TypeScript）
