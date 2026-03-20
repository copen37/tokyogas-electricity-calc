"use client";

import { useState } from "react";
import { calculate, type GasMode } from "@/lib/calc";

export default function Home() {
  const [contractAmpere, setContractAmpere] = useState(40);
  const [yearMonth, setYearMonth] = useState("2026-04");
  const [usageKwh, setUsageKwh] = useState(320);
  const [gasMode, setGasMode] = useState<GasMode>("both");
  const [result, setResult] = useState<ReturnType<typeof calculate> | null>(null);

  return (
    <main style={{ maxWidth: 900, margin: "0 auto" }}>
      <h1>東京ガス 電気料金比較（ブラウザ版）</h1>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
        <label>契約A
          <input type="number" value={contractAmpere} onChange={(e) => setContractAmpere(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>年月 (YYYY-MM)
          <input value={yearMonth} onChange={(e) => setYearMonth(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>使用量 kWh
          <input type="number" value={usageKwh} onChange={(e) => setUsageKwh(Number(e.target.value))} style={{ width: "100%" }} />
        </label>
        <label>ガス有無
          <select value={gasMode} onChange={(e) => setGasMode(e.target.value as GasMode)} style={{ width: "100%" }}>
            <option value="both">both</option>
            <option value="with">with</option>
            <option value="without">without</option>
          </select>
        </label>
      </div>

      <button onClick={() => setResult(calculate({ contractAmpere, yearMonth, usageKwh, gasMode }))} style={{ marginTop: 16, padding: "8px 16px" }}>
        実行
      </button>

      {result && (
        <div style={{ marginTop: 24, display: "grid", gap: 24 }}>
          {result.withGas.length > 0 && (
            <section>
              <h2>has_gas = true</h2>
              <ol>
                {result.withGas.slice(0, 10).map((r) => (
                  <li key={`w-${r.planId}`}>{r.planId} ({r.name}) : {r.totalFloorYen}円</li>
                ))}
              </ol>
            </section>
          )}

          {result.withoutGas.length > 0 && (
            <section>
              <h2>has_gas = false</h2>
              <ol>
                {result.withoutGas.slice(0, 10).map((r) => (
                  <li key={`wo-${r.planId}`}>{r.planId} ({r.name}) : {r.totalFloorYen}円</li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
