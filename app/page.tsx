"use client";

import JSZip from "jszip";
import { useMemo, useState } from "react";
import { calculate, type ContractType, type GasMode, type Result, type VariableUnitMode } from "@/lib/calc";
import { parseBillUsageCsv, type BillUsageRecord } from "@/lib/billUsage";
import { aggregateMonthlyUsage, aggregatePeriodUsage, parseUsageCsvRows, type MonthlyUsage, type PeriodUsage, type PowerUnit, type UsageRecord } from "@/lib/csvUsage";

type InputMode = "total" | "split";
type BillCalcMode = "month" | "period";
type CsvKind = "timeseries" | "bill-usage";
type Step = 1 | 2 | 3 | 4 | 5;

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

function detectCsvKind(text: string): CsvKind {
  const lower = text.slice(0, 3000).toLowerCase();
  if (lower.includes("#") && (lower.includes("usage_kwh") || lower.includes("請求額") || lower.includes("請求期間"))) return "bill-usage";
  return "timeseries";
}

function fmtYen(v: number | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return `${Math.floor(v).toLocaleString()}円`;
}

function StepNav({ current, jump }: { current: Step; jump: (s: Step) => void }) {
  const labels: Array<{ id: Step; name: string }> = [
    { id: 1, name: "入力方法" },
    { id: 2, name: "契約条件" },
    { id: 3, name: "データ入力" },
    { id: 4, name: "比較" },
    { id: 5, name: "結果" },
  ];
  return (
    <ol style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, padding: 0, listStyle: "none" }}>
      {labels.map((s) => (
        <li key={s.id}>
          <button
            onClick={() => jump(s.id)}
            style={{
              width: "100%",
              border: "1px solid #ddd",
              background: current === s.id ? "#111827" : "#fff",
              color: current === s.id ? "#fff" : "#111",
              borderRadius: 8,
              padding: "8px 6px",
              fontSize: 12,
            }}
          >
            STEP{s.id}<br />{s.name}
          </button>
        </li>
      ))}
    </ol>
  );
}

function BillBreakdown({ title, r }: { title: string; r: Result }) {
  const b = r.breakdown;
  return (
    <details style={{ border: "1px solid #ddd", borderRadius: 10, padding: 10 }}>
      <summary style={{ fontWeight: 700 }}>{title}</summary>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginTop: 8 }}>
        <div>基本料金</div><div>{fmtYen(b.base)}</div>
        <div>電力量料金 合計</div><div>{fmtYen(b.energy)}</div>
        <div>燃料費調整額</div><div>{fmtYen(b.fuel)}</div>
        <div>再エネ賦課金</div><div>{fmtYen(b.renewable)}</div>
        <div>国支援値引き</div><div>-{fmtYen(b.gov)}</div>
        <div>セット割</div><div>-{fmtYen(b.discount)}</div>
        <div style={{ fontWeight: 700 }}>合計</div><div style={{ fontWeight: 700 }}>{r.totalFloorYen.toLocaleString()}円</div>
      </div>
    </details>
  );
}

export default function Home() {
  const [step, setStep] = useState<Step>(1);
  const [csvKind, setCsvKind] = useState<CsvKind>("timeseries");

  const [contractType, setContractType] = useState<ContractType>("ampere");
  const [contractValue, setContractValue] = useState(50);
  const [yearMonth, setYearMonth] = useState("2026-02");
  const [inputMode, setInputMode] = useState<InputMode>("total");
  const [totalKwh, setTotalKwh] = useState(320);
  const [dayKwh, setDayKwh] = useState(250);
  const [nightKwh, setNightKwh] = useState(70);
  const [gasMode, setGasMode] = useState<GasMode>("both");

  const [billCalcMode, setBillCalcMode] = useState<BillCalcMode>("month");
  const [variableUnitMode, setVariableUnitMode] = useState<VariableUnitMode>("single_month_end");

  const [csvUnit, setCsvUnit] = useState<PowerUnit>("W");
  const [files, setFiles] = useState<UploadedSource[]>([]);
  const [recordsMap, setRecordsMap] = useState<Map<number, UsageRecord>>(new Map());
  const [csvError, setCsvError] = useState<string | null>(null);
  const [billRecords, setBillRecords] = useState<BillUsageRecord[]>([]);
  const [actualBillYen, setActualBillYen] = useState<number | null>(null);

  const [startDate, setStartDate] = useState("2026-01-10");
  const [endDate, setEndDate] = useState("2026-02-09");
  const [treatPeriodAsBillingMonth, setTreatPeriodAsBillingMonth] = useState(true);
  const [appliedPeriodDays, setAppliedPeriodDays] = useState<number | null>(null);

  const [result, setResult] = useState<ReturnType<typeof calculate> | null>(null);

  const allRecords = useMemo(() => [...recordsMap.values()].sort((a, b) => a.epochMs - b.epochMs), [recordsMap]);
  const csvRows = useMemo<MonthlyUsage[]>(() => aggregateMonthlyUsage(allRecords, csvUnit), [allRecords, csvUnit]);
  const periodUsage = useMemo<PeriodUsage | null>(() => aggregatePeriodUsage(allRecords, csvUnit, startDate, endDate), [allRecords, csvUnit, startDate, endDate]);

  const rawUsage = useMemo(() => {
    if (inputMode === "split") return { totalKwh: Number(dayKwh) + Number(nightKwh), dayKwh: Number(dayKwh), nightKwh: Number(nightKwh) };
    return { totalKwh: Number(totalKwh) };
  }, [inputMode, totalKwh, dayKwh, nightKwh]);

  const usage = useMemo(() => {
    if (!appliedPeriodDays || appliedPeriodDays <= 0 || treatPeriodAsBillingMonth) return rawUsage;
    const factor = daysInMonth(yearMonth) / appliedPeriodDays;
    if (typeof rawUsage.dayKwh === "number" && typeof rawUsage.nightKwh === "number") {
      return { totalKwh: rawUsage.totalKwh * factor, dayKwh: rawUsage.dayKwh * factor, nightKwh: rawUsage.nightKwh * factor };
    }
    return { totalKwh: rawUsage.totalKwh * factor };
  }, [rawUsage, appliedPeriodDays, treatPeriodAsBillingMonth, yearMonth]);

  const ranked = useMemo(() => {
    if (!result) return [] as Result[];
    const list = [...result.withGas, ...result.withoutGas];
    return list.sort((a, b) => a.totalFloorYen - b.totalFloorYen);
  }, [result]);

  const best = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  const gapVsSecond = best && second ? second.totalFloorYen - best.totalFloorYen : null;
  const diffVsActualYen = best && actualBillYen != null ? best.totalFloorYen - actualBillYen : null;

  async function extractRecordsFromFile(file: File): Promise<{ sources: UploadedSource[]; records: UsageRecord[] }> {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const records: UsageRecord[] = [];
      const sources: UploadedSource[] = [];
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".csv"));
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
      const appendBills: BillUsageRecord[] = [];

      for (const file of Array.from(selectedFiles)) {
        const text = decodeBytes(new Uint8Array(await file.arrayBuffer()));
        const kind = detectCsvKind(text);
        setCsvKind(kind);

        if (kind === "bill-usage") {
          const rows = parseBillUsageCsv(text);
          appendBills.push(...rows);
          sourceList.push({ name: file.name, rows: rows.length });
        } else {
          const { sources, records } = await extractRecordsFromFile(file);
          sourceList.push(...sources);
          appendRecords.push(...records);
        }
      }

      setFiles((prev) => [...prev, ...sourceList]);
      setRecordsMap((prev) => {
        const next = new Map(prev);
        for (const r of appendRecords) next.set(r.epochMs, r);
        return next;
      });
      if (appendBills.length > 0) setBillRecords((prev) => [...prev, ...appendBills]);
    } catch (e: any) {
      setCsvError(e?.message ?? "CSV/ZIPの解析に失敗しました");
    }
  }

  function clearAllCsv() {
    setFiles([]);
    setRecordsMap(new Map());
    setBillRecords([]);
    setCsvError(null);
    setActualBillYen(null);
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

  function applyBillRecord(row: BillUsageRecord) {
    setStartDate(row.periodStart);
    setEndDate(row.periodEnd);
    setYearMonth(row.periodEnd.slice(0, 7));
    setBillCalcMode("period");
    setInputMode("total");
    setTotalKwh(Number(row.usageKwh.toFixed(3)));
    setAppliedPeriodDays(Math.round((new Date(`${row.periodEnd}T00:00:00+09:00`).getTime() - new Date(`${row.periodStart}T00:00:00+09:00`).getTime()) / 86400000) + 1);
    if (row.billYen != null) setActualBillYen(row.billYen);
    if (row.contractType && row.contractValue) {
      setContractType(row.contractType);
      setContractValue(row.contractValue);
    }
    setStep(4);
  }

  function runCompare() {
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
    );
    setStep(5);
  }

  function downloadBillTemplate() {
    const tpl = `# bill-usage\nperiod_start,2026-01-10\nperiod_end,2026-02-09\nusage_kwh,325.4\nbill_yen,12780\ncontract,50A\n`;
    const blob = new Blob([tpl], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bill-usage-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", paddingBottom: 80 }}>
      <h1 style={{ marginBottom: 8 }}>東京ガス 電気料金比較</h1>
      <p style={{ marginTop: 0, color: "#555" }}>結論ファースト：最安プランと差額を先に表示します（C導線優先）</p>

      <StepNav current={step} jump={setStep} />

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>STEP1 入力方法を選択</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label><input type="radio" checked={csvKind === "bill-usage"} onChange={() => setCsvKind("bill-usage")} /> 請求CSV（bill-usage）</label>
          <label><input type="radio" checked={csvKind === "timeseries"} onChange={() => setCsvKind("timeseries")} /> 時系列CSV（timestamp,power）</label>
        </div>
        <p style={{ color: "#666", marginBottom: 0 }}>アップロード時に自動判定します。判定ミス時はここで切替してください。</p>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>STEP2 契約条件</h2>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
          <label>契約タイプ
            <select value={contractType} onChange={(e) => setContractType(e.target.value as ContractType)} style={{ width: "100%" }}>
              <option value="ampere">A (アンペア)</option>
              <option value="kva">kVA</option>
              <option value="kw">kW</option>
            </select>
          </label>
          <label>{contractType === "ampere" ? "契約A" : contractType === "kva" ? "契約kVA" : "契約kW"}
            <input type="number" value={contractValue} onChange={(e) => setContractValue(Number(e.target.value))} style={{ width: "100%" }} />
          </label>
          <label>年月
            <input value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label>ガス有無
            <select value={gasMode} onChange={(e) => setGasMode(e.target.value as GasMode)} style={{ width: "100%" }}>
              <option value="both">both</option><option value="with">with</option><option value="without">without</option>
            </select>
          </label>
        </div>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>STEP3 データ入力</h2>
        <input type="file" multiple accept=".csv,text/csv,.zip,application/zip" onChange={(e) => onCsvUpload(e.target.files)} style={{ width: "100%" }} />
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={clearAllCsv}>全クリア</button>
          <button onClick={downloadBillTemplate}>bill-usage テンプレDL</button>
          <span style={{ color: "#666" }}>種別: {csvKind} / 取込: {files.length} / レコード: {allRecords.length}</span>
        </div>
        {csvError && (
          <div style={{ marginTop: 10, color: "crimson" }}>
            <div>エラー: {csvError}</div>
            <ul style={{ margin: "6px 0 0 18px" }}>
              <li>請求CSV: period_start / period_end / usage_kwh を確認</li>
              <li>時系列CSV: timestamp,power（または 計測日時,買電）を確認</li>
            </ul>
          </div>
        )}

        {csvKind === "timeseries" && (
          <>
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label>power unit
                <select value={csvUnit} onChange={(e) => setCsvUnit(e.target.value as PowerUnit)}>
                  <option value="W">W</option><option value="kW">kW</option><option value="Wh">Wh</option><option value="kWh">kWh</option>
                </select>
              </label>
            </div>

            <details style={{ marginTop: 8 }} open>
              <summary>期間指定（既存機能）</summary>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 1fr", marginTop: 6 }}>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              {periodUsage && (
                <div style={{ marginTop: 8 }}>
                  total {periodUsage.totalKwh.toFixed(3)} / day {periodUsage.dayKwh.toFixed(3)} / night {periodUsage.nightKwh.toFixed(3)}
                  <button style={{ marginLeft: 8 }} onClick={() => applyPeriod(periodUsage)}>フォームへ反映</button>
                </div>
              )}
            </details>

            {csvRows.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary>月次集計（既存機能）</summary>
                <table style={{ width: "100%", marginTop: 8 }}>
                  <tbody>
                    {csvRows.map((row) => (
                      <tr key={row.month}>
                        <td>{row.month}</td><td align="right">{row.totalKwh.toFixed(3)}kWh</td>
                        <td align="right"><button onClick={() => applyMonth(row)}>反映</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </>
        )}

        {billRecords.length > 0 && (
          <details style={{ marginTop: 10 }} open>
            <summary>請求CSV 抽出結果</summary>
            <table style={{ width: "100%", marginTop: 8 }}>
              <thead><tr><th align="left">期間</th><th>使用量</th><th>請求額</th><th>契約</th><th /></tr></thead>
              <tbody>
                {billRecords.map((r, i) => (
                  <tr key={`${r.periodStart}-${i}`}>
                    <td>{r.periodStart}〜{r.periodEnd}</td>
                    <td align="right">{r.usageKwh.toFixed(3)}kWh</td>
                    <td align="right">{r.billYen?.toLocaleString() ?? "-"}円</td>
                    <td align="right">{r.contractValue ? `${r.contractValue}${r.contractType === "ampere" ? "A" : r.contractType}` : "-"}</td>
                    <td align="right"><button onClick={() => applyBillRecord(r)}>フォームへ反映</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        <div style={{ marginTop: 10 }}>
          <label><input type="radio" checked={inputMode === "total"} onChange={() => setInputMode("total")} /> 総kWh</label>
          <label style={{ marginLeft: 12 }}><input type="radio" checked={inputMode === "split"} onChange={() => setInputMode("split")} /> 昼夜kWh</label>
          {inputMode === "total" ? (
            <input style={{ marginLeft: 8 }} type="number" value={totalKwh} onChange={(e) => setTotalKwh(Number(e.target.value))} />
          ) : (
            <span>
              <input style={{ marginLeft: 8, width: 100 }} type="number" value={dayKwh} onChange={(e) => setDayKwh(Number(e.target.value))} />
              <input style={{ marginLeft: 8, width: 100 }} type="number" value={nightKwh} onChange={(e) => setNightKwh(Number(e.target.value))} />
            </span>
          )}
        </div>
      </section>

      <section style={{ border: "1px solid #ddd", borderRadius: 10, padding: 14, marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>STEP4 比較</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label><input type="radio" checked={billCalcMode === "month"} onChange={() => setBillCalcMode("month")} /> 単月</label>
          <label><input type="radio" checked={billCalcMode === "period"} onChange={() => setBillCalcMode("period")} /> 期間指定</label>
          <label><input type="checkbox" checked={treatPeriodAsBillingMonth} onChange={(e) => setTreatPeriodAsBillingMonth(e.target.checked)} /> 期間を1請求月として扱う</label>
        </div>
        {billCalcMode === "period" && (
          <label style={{ display: "block", marginTop: 8 }}>変動単価
            <select value={variableUnitMode} onChange={(e) => setVariableUnitMode(e.target.value as VariableUnitMode)}>
              <option value="single_month_end">終了月単価を適用</option>
              <option value="prorated_by_day">日数按分</option>
            </select>
          </label>
        )}
      </section>

      <div className="stickyCta">
        <button onClick={runCompare} style={{ width: "100%", padding: "12px 16px", fontWeight: 700 }}>STEP5 結果を見る</button>
      </div>

      {result && (
        <section style={{ border: "2px solid #111827", borderRadius: 10, padding: 14, marginTop: 14 }}>
          <h2 style={{ marginTop: 0 }}>STEP5 結果（結論ファースト）</h2>
          {best ? (
            <>
              <p style={{ fontSize: 20, margin: "8px 0" }}>最安: <strong>{best.name}</strong>（{best.totalFloorYen.toLocaleString()}円）</p>
              <p style={{ margin: "6px 0" }}>次点との差額: {gapVsSecond != null ? `${gapVsSecond.toLocaleString()}円` : "-"}</p>
              <p style={{ margin: "6px 0" }}>実績請求額との差分: {diffVsActualYen != null ? `${diffVsActualYen > 0 ? "+" : ""}${diffVsActualYen.toLocaleString()}円 / ${actualBillYen ? ((diffVsActualYen / actualBillYen) * 100).toFixed(1) : "-"}%` : "実績請求額が未設定"}</p>
              <details>
                <summary>全プラン上位10</summary>
                <ol>{ranked.slice(0, 10).map((r) => <li key={r.planId}>{r.name} : {r.totalFloorYen.toLocaleString()}円</li>)}</ol>
              </details>
              <div style={{ display: "grid", gap: 8 }}>
                <BillBreakdown title={`内訳: ${best.name}`} r={best} />
              </div>
            </>
          ) : <p>計算結果なし</p>}
        </section>
      )}

      <style jsx>{`
        .stickyCta { position: sticky; bottom: 0; background: #fff; padding-top: 10px; margin-top: 10px; }
        @media (max-width: 760px) {
          .stickyCta { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid #ddd; padding: 10px; z-index: 20; }
          main { padding-bottom: 90px; }
        }
      `}</style>
    </main>
  );
}
