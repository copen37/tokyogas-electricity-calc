Tokyo Gas 比較/請求試算ツール README

配置ファイル:
- tokyogas_billing_calc.py
- plans.json
- unit_prices_template.json
- tokyogas_plan_matrix.txt

1) できること
- --compare-plans で全プラン横並び比較
- --gas-mode both|with|without
  - both のとき「ガスあり最安」「ガスなし最安」を別表示
- 単一プラン計算: --plan <id> --has-gas true|false
- CSV任意粒度（1分/5分/15分/30分/60分など）
- 変動単価（燃料費調整・再エネ賦課金・国支援）を月指定で適用

2) 主要オプション
- --plans plans.json
- --unit-prices unit_prices_template.json
- --year-month YYYY-MM
- --usage-kwh 320
- --csv usage.csv --timestamp-col timestamp --power-col power --power-unit W|kW|Wh|kWh [--dt-minutes 15]
- 契約条件: --contract-ampere 40 / --contract-kva 8 / --contract-kw 10

3) 実行例
(比較: ガスあり/なし両方)
python3 tokyogas_billing_calc.py \
  --compare-plans \
  --plans plans.json \
  --unit-prices unit_prices_template.json \
  --year-month 2026-02 \
  --usage-kwh 320 \
  --contract-ampere 40 \
  --gas-mode both

(単一プラン)
python3 tokyogas_billing_calc.py \
  --plan basic \
  --plans plans.json \
  --unit-prices unit_prices_template.json \
  --year-month 2026-02 \
  --usage-kwh 320 \
  --contract-ampere 40 \
  --has-gas true

(CSV計算: 15分Wデータ)
python3 tokyogas_billing_calc.py \
  --compare-plans \
  --csv usage_15min.csv \
  --timestamp-col timestamp \
  --power-col power \
  --power-unit W \
  --dt-minutes 15 \
  --contract-kva 8 \
  --year-month 2026-04 \
  --gas-mode with

4) CSVフォーマット例
4-1) W/kW（時系列積分）
timestamp,power
2026-02-01T00:00:00+09:00,420
2026-02-01T00:15:00+09:00,390
...
- power-unit=W or kW
- dtは自動推定（timestamp差分中央値）または --dt-minutes

4-2) Wh/kWh（積算量）
timestamp,power
2026-02-01T00:00:00+09:00,105
2026-02-01T00:15:00+09:00,98
...
- power-unit=Wh or kWh
- dt不要

5) 端数処理・税込/税抜扱い
- 本ツールは plans.json の単価を「税込想定」として計算
- 出力各行に [税込想定] ラベルを表示
- 合計は円未満切り捨て（total_floor_yen）

6) 変動単価の差し替え
- unit_prices_template.json の monthly_adjustments.months[YYYY-MM] を更新
  - fuel_adjustment_yen_per_kwh
  - gov_support_yen_per_kwh
- 年度賦課金は annual_levies[FYxxxx].renewable_surcharge_yen_per_kwh を更新
- 計算時に --year-month で対象月を指定

7) 注意
- 公式サイト利用規約・robots.txtを尊重し、抽出は最小限で実施
- さすてな電気/時間帯別は unit_price.html 本体に表がなく、公式PDF単価表を参照
- ずっとも電気1S のセット割率（定率A）は要確認（必要時に --set-discount-rate で補完）
