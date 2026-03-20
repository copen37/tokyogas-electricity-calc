"use client";

import JSZip from "jszip";
import { useMemo, useState } from "react";
import { calculate, type ContractType, type GasMode, type Result, type VariableUnitMode } from "@/lib/calc";
import { aggregateMonthlyUsage, aggregatePeriodUsage, parseUsageCsvRows, type MonthlyUsage, type PeriodUsage, type PowerUnit, type UsageRecord } from "@/lib/csvUsage";

type InputMode = "total" | "split";
type BillCalcMode = "month" | "period";

type UploadedSource = {
  name: string;
  rows: number;
};

function decodeBytes(bytes: Uint8Array): string {
  const tryDecode = (encoding: string) => new TextDecoder(encoding as any, { fatal: true }).decode(bytes);
  try {
    return tryDecode("utf-8");
  } catch {
    return tryDecode("shift-jis");
  }
}

function daysInMonth(yearMonth: string): number {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return 30;
  return new Date(y, m, 0).getDate();
}

function fmt(v: number | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return `${v.toFixed(2)}円`;
}

function BillBreakdown({ title, r }: { title: string; r: Result }) {
  const b = r.breakdown;
  return (
    <div style={{ border: "1px solid #ddd", padding: 10, marginTop: 10 }}>
      <h4 style={{ margin: "0 0 8px" }}>{title}</h4>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
        <div>基本料金</div><div>{fmt(b.base)}</div>
        <div>電力量料金 1段階目</div><div>{fmt(b.energyTier1)}</div>
        <div>電力量料金 2段階目</div><div>{fmt(b.energyTier2)}</div>
        <div>電力量料金 3段階目</div><div>{fmt(b.energyTier3)}</div>
        <div>電力量料金 合計</div><div>{fmt(b.energy)}</div>
        <div>燃料費調整額</div><div>{fmt(b.fuel)}</div>
        <div>再エネ賦課金</div><div>{fmt(b.renewable)}</div>
        <div>国支援値引き</div><div>{fmt(-b.gov)}</div>
        <div>セット割</div><div>{fmt(-b.discount)}</div>
        <div style={{ fontWeight: 700 }}>合計（円未満切り捨て）</div><div style={{ fontWeight: 700 }}>{r.totalFloorYen}円</div>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary>差分調査ログ</summary>
        <pre style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{JSON.stringify(r.diagnostics, null, 2)}</pre>
      </details>
    </div>
  );
}

export default function Home() {
  const [contractType, setContractType] = useState<ContractType>("ampere");
  const [contractValue, setContractValue] = useState(50);
  const [yearMonth, setYearMonth] = useState("2026-02");
  const [inputMode, setInputMode] = useState<InputMode>("total");
  const [totalKwh, setTotalKwh] = useState(320);
  const [dayKwh, setDayKwh] = useState(250);
  const [nightKwh, setNightKwh] = useState(70);
  const [gasMode, setGasMode] = useState<GasMode>("both");
  const [result, setResult] = useState<ReturnType<typeof calculate> | null>(null);

  const [billCalcMode, setBillCalcMode] = useState<BillCalcMode>("month");
  const [variableUnitMode, setVariableUnitMode] = useState<VariableUnitMode>("single_month_end");

  const [csvUnit, setCsvUnit] = useState<PowerUnit>("W");
  const [files, setFiles] = useState<UploadedSource[]>([]);
  const [recordsMap, setRecordsMap] = useState<Map<number, UsageRecord>>(new Map());
  const [csvError, setCsvError] = useState<string | null>(null);

  const [startDate, setStartDate] = useState("2026-01-10");
  const [endDate, setEndDate] = useState("2026-02-09");
  const [treatPeriodAsBillingMonth, setTreatPeriodAsBillingMonth] = useState(true);
  const [appliedPeriodDays, setAppliedPeriodDays] = useState<number | null>(null);

  const allRecords = useMemo(() => [...recordsMap.values()].sort((a, b) => a.epochMs - b.epochMs), [recordsMap]);
  const csvRows = useMemo<MonthlyUsage[]>(() => aggregateMonthlyUsage(allRecords, csvUnit), [allRecords, csvUnit]);
  const periodUsage = useMemo<PeriodUsage | null>(() => aggregatePeriodUsage(allRecords, csvUnit, startDate, endDate), [allRecords, csvUnit, startDate, endDate]);

  const rawUsage = useMemo(() => {
    if (inputMode === "split") {
      const sum = Number(dayKwh) + Number(nightKwh);
      return { totalKwh: sum, dayKwh: Number(dayKwh), nightKwh: Number(nightKwh) };
    }
    return { totalKwh: Number(totalKwh) };
  }, [inputMode, totalKwh, dayKwh, nightKwh]);

  const usage = useMemo(() => {
    if (!appliedPeriodDays || appliedPeriodDays <= 0 || treatPeriodAsBillingMonth) return rawUsage;

    const factor = daysInMonth(yearMonth) / appliedPeriodDays;
    if (typeof rawUsage.dayKwh === "number" && typeof rawUsage.nightKwh === "number") {
      return {
        totalKwh: rawUsage.totalKwh * factor,
        dayKwh: rawUsage.dayKwh * factor,
        nightKwh: rawUsage.nightKwh * factor,
      };
    }
    return { totalKwh: rawUsage.totalKwh * factor };
  }, [rawUsage, appliedPeriodDays, treatPeriodAsBillingMonth, yearMonth]);

  async function extractRecordsFromFile(file: File): Promise<{ sources: UploadedSource[]; records: UsageRecord[] }> {
    const lower = file.name.toLowerCase();

    if (lower.endsWith(".zip")) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const records: UsageRecord[] = [];
      const sources: UploadedSource[] = [];

      const entries = Object.values(zip.files)
        .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".csv"))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const text = decodeBytes(await entry.async("uint8array"));
        const rows = parseUsageCsvRows(text, csvUnit);
        records.push(...rows);
        sources.push({ name: `${file.name}::${entry.name}`, rows: rows.length });
      }

      return { sources, records };
    }

    const text = decodeBytes(new Uint8Array(await file.arrayBuffer()));
    const rows = parseUsageCsvRows(text, csvUnit);
    return { sources: [{ name: file.name, rows: rows.length }], records: rows };
  }

  async function onCsvUpload(selectedFiles: FileList | null) {
    if (!selectedFiles || selectedFiles.length === 0) return;

    setCsvError(null);
    try {
      const sourceList: UploadedSource[] = [];
      const appendRecords: UsageRecord[] = [];

      for (const file of Array.from(selectedFiles)) {
        const { sources, records } = await extractRecordsFromFile(file);
        sourceList.push(...sources);
        appendRecords.push(...records);
      }

      setFiles((prev) => [...prev, ...sourceList]);
      setRecordsMap((prev) => {
        const next = new Map(prev);
        for (const r of appendRecords) next.set(r.epochMs, r);
        return next;
      });
    } catch (e: any) {
      setCsvError(e?.message ?? "CSV/ZIPの解析に失敗しました");
    }
  }

  function clearAllCsv() {
    setFiles([]);
    setRecordsMap(new Map());
    setCsvError(null);
  }

  function applyMonth(row: MonthlyUsage) {
    setYearMonth(row.month);
    setInputMode("split");
    setDayKwh(Number(row.dayKwh.toFixed(3)));
    setNightKwh(Number(row.nightKwh.toFixed(3)));
    setTotalKwh(Number(row.totalKwh.toFixed(3)));
    setAppliedPeriodDays(null);
    setBillCalcMode("month");
  }

  function applyPeriod(row: PeriodUsage) {
    setYearMonth(row.endDate.slice(0, 7));
    setInputMode("split");
    setDayKwh(Number(row.dayKwh.toFixed(3)));
    setNightKwh(Number(row.nightKwh.toFixed(3)));
    setTotalKwh(Number(row.totalKwh.toFixed(3)));
    setAppliedPeriodDays(row.periodDays);
    setBillCalcMode("period");
  }

  const bestWithGas = result?.withGas.find((r) => r.planId === "basic") ?? result?.withGas[0] ?? null;
  const bestWithoutGas = result?.withoutGas.find((r) => r.planId === "basic") ?? result?.withoutGas[0] ?? null;

  return (
    <main style={{ maxWidth: 980, margin: "0 auto" }}>
      <h1>東京ガス 電気料金比較（ブラウザ版）</h1>

      <section style={{ border: "1px solid #ddd", padding: 12, marginBottom: 16 }}>
        <h2>契約条件</h2>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <label>
            契約タイプ
            <select
              value={contractType}
              onChange={(e) => {
                const v = e.target.value as ContractType;
                setContractType(v);
                if (v === "ampere") setContractValue(50);
                if (v === "kva") setContractValue(30);
                if (v === "kw") setContractValue(6);
              }}
              style={{ width: "100%" }}
            >
              <option value="ampere">A (アンペア)</option>
              <option value="kva">kVA</option>
              <option value="kw">kW</option>
            </select>
          </label>

          <label>
            年月 (YYYY-MM)
            <input value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} style={{ width: "100%" }} />
          </label>

          <label>
            {contractType === "ampere" ? "契約A" : contractType === "kva" ? "契約kVA" : "契約kW"}
            <input
              type="number"
              step={contractType === "ampere" ? 5 : 0.1}
              value={contractValue}
              onChange={(e) => setContractValue(Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </label>

          <label>
            ガス有無
            <select value={gasMode} onChange={(e) => setGasMode(e.target.value as GasMode)} style={{ width: "100%" }}>
              <option value="both">both</option>
              <option value="with">with</option>
              <option value="without">without</option>
            </select>
          </label>
        </div>
      </section>

      <section style={{ border: "1px solid #ddd", padding: 12, marginBottom: 16 }}>
        <h2>使用量入力</h2>
        <div style={{ marginBottom: 8 }}>
          <label style={{ marginRight: 12 }}>
            <input type="radio" checked={inputMode === "total"} onChange={() => setInputMode("total")} /> 総kWh入力
          </label>
          <label>
            <input type="radio" checked={inputMode === "split"} onChange={() => setInputMode("split")} /> 時間帯別入力（昼/夜）
          </label>
        </div>

        {inputMode === "total" ? (
          <label>
            使用量 kWh
            <input type="number" value={totalKwh} onChange={(e) => setTotalKwh(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
        ) : (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
            <label>
              昼 kWh (06:00-01:00)
              <input type="number" value={dayKwh} onChange={(e) => setDayKwh(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <label>
              夜 kWh (01:00-06:00)
              <input type="number" value={nightKwh} onChange={(e) => setNightKwh(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
          </div>
        )}
        <p>合計: {(Number(dayKwh) + Number(nightKwh)).toFixed(3)} kWh</p>
      </section>

      <section style={{ border: "1px solid #ddd", padding: 12, marginBottom: 16 }}>
        <h2>請求期間モード</h2>
        <label style={{ marginRight: 12 }}>
          <input type="radio" checked={billCalcMode === "month"} onChange={() => setBillCalcMode("month")} /> 単月
        </label>
        <label>
          <input type="radio" checked={billCalcMode === "period"} onChange={() => setBillCalcMode("period")} /> 期間指定
        </label>

        {billCalcMode === "period" && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <label>
                開始日
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ width: "100%" }} />
              </label>
              <label>
                終了日
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ width: "100%" }} />
              </label>
            </div>
            <label style={{ display: "block", marginTop: 8 }}>
              <input type="checkbox" checked={treatPeriodAsBillingMonth} onChange={(e) => setTreatPeriodAsBillingMonth(e.target.checked)} /> この期間を1請求月として扱う
            </label>
            <label style={{ display: "block", marginTop: 8 }}>
              変動単価の扱い
              <select value={variableUnitMode} onChange={(e) => setVariableUnitMode(e.target.value as VariableUnitMode)} style={{ width: "100%" }}>
                <option value="single_month_end">検針終了月の単価を全期間に適用</option>
                <option value="prorated_by_day">日数按分（月跨ぎ時に月別単価を按分）</option>
              </select>
            </label>
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #ddd", padding: 12, marginBottom: 16 }}>
        <h2>CSVアップロード（timestamp,power / 計測日時,買電）</h2>
        <input type="file" multiple accept=".csv,text/csv,.zip,application/zip" onChange={(e) => onCsvUpload(e.target.files)} style={{ width: "100%" }} />
        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <button onClick={clearAllCsv}>全クリア</button>
          <span style={{ color: "#666" }}>取込ソース: {files.length} / 有効レコード: {allRecords.length}</span>
        </div>
        {periodUsage && (
          <div style={{ marginTop: 12, border: "1px dashed #aaa", padding: 10 }}>
            <h3 style={{ marginTop: 0 }}>期間集計（{periodUsage.startDate} 〜 {periodUsage.endDate}）</h3>
            <p style={{ margin: "6px 0" }}>
              total: {periodUsage.totalKwh.toFixed(3)} / day: {periodUsage.dayKwh.toFixed(3)} / night: {periodUsage.nightKwh.toFixed(3)} kWh（{periodUsage.records} records）
            </p>
            <button onClick={() => applyPeriod(periodUsage)}>この期間を入力へ反映</button>
          </div>
        )}
        {csvError && <p style={{ color: "crimson" }}>{csvError}</p>}

        {csvRows.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h3>月次集計</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th align="left">month</th><th align="right">total_kWh</th><th /></tr></thead>
              <tbody>
                {csvRows.map((row) => (
                  <tr key={row.month}>
                    <td>{row.month}</td>
                    <td align="right">{row.totalKwh.toFixed(3)}</td>
                    <td align="right"><button onClick={() => applyMonth(row)}>この月を入力へ反映</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <button
        onClick={() =>
          setResult(
            calculate({
              contractType,
              contractValue,
              yearMonth,
              usage,
              gasMode,
              periodStartDate: billCalcMode === "period" ? startDate : undefined,
              periodEndDate: billCalcMode === "period" ? endDate : undefined,
              variableUnitMode: billCalcMode === "period" ? variableUnitMode : "single_month_end",
            })
          )
        }
        style={{ marginTop: 4, padding: "8px 16px" }}
      >
        実行
      </button>

      {appliedPeriodDays && !treatPeriodAsBillingMonth && (
        <p style={{ color: "#666" }}>
          比較計算では {appliedPeriodDays}日分を {daysInMonth(yearMonth)}日換算して適用（係数 {(daysInMonth(yearMonth) / appliedPeriodDays).toFixed(4)}）
        </p>
      )}

      {result && (
        <div style={{ marginTop: 24, display: "grid", gap: 24 }}>
          {result.withGas.length > 0 && (
            <section>
              <h2>has_gas = true（上位10）</h2>
              <ol>
                {result.withGas.slice(0, 10).map((r) => (
                  <li key={`w-${r.planId}`}>{r.planId} ({r.name}) : {r.totalFloorYen}円</li>
                ))}
              </ol>
              {bestWithGas && <BillBreakdown title={`検針票風内訳: ${bestWithGas.planId}`} r={bestWithGas} />}
            </section>
          )}

          {result.withoutGas.length > 0 && (
            <section>
              <h2>has_gas = false（上位10）</h2>
              <ol>
                {result.withoutGas.slice(0, 10).map((r) => (
                  <li key={`wo-${r.planId}`}>{r.planId} ({r.name}) : {r.totalFloorYen}円</li>
                ))}
              </ol>
              {bestWithoutGas && <BillBreakdown title={`検針票風内訳: ${bestWithoutGas.planId}`} r={bestWithoutGas} />}
            </section>
          )}
        </div>
      )}
    </main>
  );
}
