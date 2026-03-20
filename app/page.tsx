"use client";

import { useMemo, useState } from "react";
import { unzipSync } from "fflate";
import { calculate, type ContractType, type GasMode } from "@/lib/calc";
import {
  aggregateMonthlyUsage,
  aggregatePeriodUsage,
  parseUsageCsvRows,
  type MonthlyUsage,
  type PeriodUsage,
  type PowerUnit,
  type UsageRecord,
} from "@/lib/csvUsage";

type InputMode = "total" | "split";

export default function Home() {
  const [contractType, setContractType] = useState<ContractType>("ampere");
  const [contractValue, setContractValue] = useState(40);
  const [yearMonth, setYearMonth] = useState("2026-04");
  const [inputMode, setInputMode] = useState<InputMode>("total");
  const [totalKwh, setTotalKwh] = useState(320);
  const [dayKwh, setDayKwh] = useState(250);
  const [nightKwh, setNightKwh] = useState(70);
  const [gasMode, setGasMode] = useState<GasMode>("both");
  const [result, setResult] = useState<ReturnType<typeof calculate> | null>(null);

  const [csvUnit, setCsvUnit] = useState<PowerUnit>("W");
  const [csvRows, setCsvRows] = useState<MonthlyUsage[]>([]);
  const [csvRecords, setCsvRecords] = useState<UsageRecord[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const [csvError, setCsvError] = useState<string | null>(null);

  const [periodStartDate, setPeriodStartDate] = useState("");
  const [periodEndDate, setPeriodEndDate] = useState("");

  const usage = useMemo(() => {
    if (inputMode === "split") {
      const sum = Number(dayKwh) + Number(nightKwh);
      return { totalKwh: sum, dayKwh: Number(dayKwh), nightKwh: Number(nightKwh) };
    }
    return { totalKwh: Number(totalKwh) };
  }, [inputMode, totalKwh, dayKwh, nightKwh]);

  const periodUsage: PeriodUsage | null = useMemo(() => {
    return aggregatePeriodUsage(csvRecords, csvUnit, periodStartDate, periodEndDate);
  }, [csvRecords, csvUnit, periodStartDate, periodEndDate]);

  function decodeCsvText(bytes: Uint8Array): string {
    const tryDecode = (encoding: string) => new TextDecoder(encoding as any, { fatal: true }).decode(bytes);
    try {
      return tryDecode("utf-8");
    } catch {
      return tryDecode("shift-jis");
    }
  }

  async function parseFileToCsvEntries(file: File): Promise<Array<{ name: string; text: string }>> {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (file.name.toLowerCase().endsWith(".zip")) {
      const unzipped = unzipSync(bytes);
      const entries: Array<{ name: string; text: string }> = [];

      Object.entries(unzipped).forEach(([name, data]) => {
        if (!name.toLowerCase().endsWith(".csv")) return;
        entries.push({ name: `${file.name}:${name}`, text: decodeCsvText(data) });
      });

      if (entries.length === 0) {
        throw new Error(`${file.name} にCSVが含まれていません`);
      }
      return entries;
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      throw new Error(`未対応形式: ${file.name}（.csv / .zip のみ対応）`);
    }

    return [{ name: file.name, text: decodeCsvText(bytes) }];
  }

  async function onCsvUpload(files: FileList) {
    setCsvError(null);
    try {
      const allEntries = (await Promise.all(Array.from(files).map((f) => parseFileToCsvEntries(f)))).flat();

      const mergedRecords = allEntries.flatMap((entry) => parseUsageCsvRows(entry.text, csvUnit));
      mergedRecords.sort((a, b) => a.epochMs - b.epochMs);

      const monthly = aggregateMonthlyUsage(mergedRecords, csvUnit);
      setCsvRecords(mergedRecords);
      setCsvRows(monthly);
      setUploadedFiles(allEntries.map((e) => e.name));

      if (mergedRecords.length > 0) {
        const firstDate = new Date(mergedRecords[0].epochMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const lastDate = new Date(mergedRecords[mergedRecords.length - 1].epochMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        setPeriodStartDate((prev) => prev || firstDate);
        setPeriodEndDate((prev) => prev || lastDate);
      }
    } catch (e: any) {
      setCsvRows([]);
      setCsvRecords([]);
      setUploadedFiles([]);
      setCsvError(e?.message ?? "CSVの解析に失敗しました");
    }
  }

  function clearUploadedData() {
    setCsvRows([]);
    setCsvRecords([]);
    setUploadedFiles([]);
    setCsvError(null);
    setPeriodStartDate("");
    setPeriodEndDate("");
  }

  function applyMonth(row: MonthlyUsage) {
    setYearMonth(row.month);
    setInputMode("split");
    setDayKwh(Number(row.dayKwh.toFixed(3)));
    setNightKwh(Number(row.nightKwh.toFixed(3)));
    setTotalKwh(Number(row.totalKwh.toFixed(3)));
  }

  function applyPeriod(agg: PeriodUsage) {
    setYearMonth(agg.startDate.slice(0, 7));
    setInputMode("split");
    setDayKwh(Number(agg.dayKwh.toFixed(3)));
    setNightKwh(Number(agg.nightKwh.toFixed(3)));
    setTotalKwh(Number(agg.totalKwh.toFixed(3)));
  }

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
                if (v === "ampere") setContractValue(40);
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
            <input type="radio" checked={inputMode === "total"} onChange={() => setInputMode("total")} /> 総kWh入力（平均単価fallback）
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
            <div>合計: {(Number(dayKwh) + Number(nightKwh)).toFixed(3)} kWh</div>
          </div>
        )}
      </section>

      <section style={{ border: "1px solid #ddd", padding: 12, marginBottom: 16 }}>
        <h2>CSV / ZIPアップロード（timestamp,power / 計測日時,買電）</h2>
        <p style={{ marginTop: 0 }}>
          複数CSVまたはZIP（中にCSV複数可）を一括読み込みできます。offsetありtimestampを優先、offset無しはAsia/Tokyo扱いです。
        </p>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <label>
            power-unit
            <select value={csvUnit} onChange={(e) => setCsvUnit(e.target.value as PowerUnit)} style={{ width: "100%" }}>
              <option>W</option>
              <option>kW</option>
              <option>Wh</option>
              <option>kWh</option>
            </select>
          </label>
          <label>
            CSV/ZIPファイル（複数選択可）
            <input type="file" multiple accept=".csv,.zip,text/csv,application/zip" onChange={(e) => e.target.files && onCsvUpload(e.target.files)} style={{ width: "100%" }} />
          </label>
        </div>

        <div style={{ marginTop: 10 }}>
          <button onClick={clearUploadedData} disabled={csvRecords.length === 0}>
            アップロード内容をクリア
          </button>
        </div>

        {uploadedFiles.length > 0 && (
          <p style={{ marginTop: 8, fontSize: 13, color: "#555" }}>読込ファイル: {uploadedFiles.join(" / ")}</p>
        )}

        {csvError && <p style={{ color: "crimson" }}>{csvError}</p>}

        {csvRows.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h3>月次集計（total/day/night）</h3>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">month</th>
                  <th align="right">total_kWh</th>
                  <th align="right">day_kWh</th>
                  <th align="right">night_kWh</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {csvRows.map((row) => (
                  <tr key={row.month}>
                    <td>{row.month}</td>
                    <td align="right">{row.totalKwh.toFixed(3)}</td>
                    <td align="right">{row.dayKwh.toFixed(3)}</td>
                    <td align="right">{row.nightKwh.toFixed(3)}</td>
                    <td align="right">
                      <button onClick={() => applyMonth(row)}>この月を入力へ反映</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {csvRecords.length > 0 && (
          <div style={{ marginTop: 16, borderTop: "1px dashed #ccc", paddingTop: 12 }}>
            <h3>期間指定集計</h3>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <label>
                開始日
                <input type="date" value={periodStartDate} onChange={(e) => setPeriodStartDate(e.target.value)} style={{ width: "100%" }} />
              </label>
              <label>
                終了日
                <input type="date" value={periodEndDate} onChange={(e) => setPeriodEndDate(e.target.value)} style={{ width: "100%" }} />
              </label>
            </div>

            {periodUsage ? (
              <div style={{ marginTop: 10 }}>
                <p>
                  {periodUsage.startDate} 〜 {periodUsage.endDate}（{periodUsage.periodDays}日 / {periodUsage.records}レコード）
                </p>
                <ul style={{ marginTop: 4 }}>
                  <li>total: {periodUsage.totalKwh.toFixed(3)} kWh</li>
                  <li>day: {periodUsage.dayKwh.toFixed(3)} kWh</li>
                  <li>night: {periodUsage.nightKwh.toFixed(3)} kWh</li>
                </ul>
                <button onClick={() => applyPeriod(periodUsage)}>期間集計を入力へ反映</button>
              </div>
            ) : (
              <p style={{ color: "#666" }}>開始日・終了日を正しく指定してください。</p>
            )}
          </div>
        )}
      </section>

      <button
        onClick={() => setResult(calculate({ contractType, contractValue, yearMonth, usage, gasMode }))}
        style={{ marginTop: 4, padding: "8px 16px" }}
      >
        実行
      </button>

      {result && (
        <div style={{ marginTop: 24, display: "grid", gap: 24 }}>
          {result.withGas.length > 0 && (
            <section>
              <h2>has_gas = true（適用プランのみ）</h2>
              <ol>
                {result.withGas.slice(0, 10).map((r) => (
                  <li key={`w-${r.planId}`}>
                    {r.planId} ({r.name}) : {r.totalFloorYen}円
                  </li>
                ))}
              </ol>
            </section>
          )}

          {result.withoutGas.length > 0 && (
            <section>
              <h2>has_gas = false（適用プランのみ）</h2>
              <ol>
                {result.withoutGas.slice(0, 10).map((r) => (
                  <li key={`wo-${r.planId}`}>
                    {r.planId} ({r.name}) : {r.totalFloorYen}円
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
