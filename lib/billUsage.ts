export type BillUsageRecord = {
  periodStart: string;
  periodEnd: string;
  usageKwh: number;
  billYen?: number;
  contractType?: "ampere" | "kva" | "kw";
  contractValue?: number;
};

function parseNumber(text: string): number | null {
  const v = Number(text.replace(/,/g, "").trim());
  return Number.isFinite(v) ? v : null;
}

function parseContract(value: string): { contractType: "ampere" | "kva" | "kw"; contractValue: number } | null {
  const t = value.trim();
  const m = t.match(/([0-9]+(?:\.[0-9]+)?)\s*(A|Ａ|kva|KVA|kw|KW)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "a" || unit === "ａ") return { contractType: "ampere", contractValue: n };
  if (unit === "kva") return { contractType: "kva", contractValue: n };
  return { contractType: "kw", contractValue: n };
}

function normalizeDate(v: string): string | null {
  const t = v.trim().replace(/[./年]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, "");
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const mm = String(Number(m[2])).padStart(2, "0");
  const dd = String(Number(m[3])).padStart(2, "0");
  return `${m[1]}-${mm}-${dd}`;
}

export function parseBillUsageCsv(text: string): BillUsageRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) throw new Error("請求CSVが空です");

  const records: BillUsageRecord[] = [];
  let current: Partial<BillUsageRecord> = {};

  const flush = () => {
    if (!current.periodStart || !current.periodEnd || typeof current.usageKwh !== "number") return;
    records.push({
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      usageKwh: current.usageKwh,
      billYen: current.billYen,
      contractType: current.contractType,
      contractValue: current.contractValue,
    });
    current = {};
  };

  for (const line of lines) {
    if (line.startsWith("#")) {
      flush();
      continue;
    }

    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 2) continue;

    const key = cols[0].toLowerCase().replace(/\s+/g, "");
    const val = cols.slice(1).join(",").trim();

    if (["period", "期間", "billing_period", "請求期間"].includes(key)) {
      const m = val.match(/(.+?)[〜~\-–](.+)/);
      if (m) {
        const s = normalizeDate(m[1]);
        const e = normalizeDate(m[2]);
        if (s) current.periodStart = s;
        if (e) current.periodEnd = e;
      }
      continue;
    }

    if (["periodstart", "開始日", "from", "start"].includes(key)) {
      const d = normalizeDate(val);
      if (d) current.periodStart = d;
      continue;
    }

    if (["periodend", "終了日", "to", "end"].includes(key)) {
      const d = normalizeDate(val);
      if (d) current.periodEnd = d;
      continue;
    }

    if (["usage_kwh", "usage", "使用量kwh", "使用量"].includes(key)) {
      const n = parseNumber(val.replace(/kwh/gi, ""));
      if (n != null) current.usageKwh = n;
      continue;
    }

    if (["bill_yen", "bill", "請求額円", "請求額"].includes(key)) {
      const n = parseNumber(val.replace(/[円¥]/g, ""));
      if (n != null) current.billYen = n;
      continue;
    }

    if (["contract", "契約", "契約容量"].includes(key)) {
      const parsed = parseContract(val);
      if (parsed) {
        current.contractType = parsed.contractType;
        current.contractValue = parsed.contractValue;
      }
      continue;
    }

    if (["yearmonth", "month", "年月"].includes(key) && !current.periodEnd) {
      const ym = val.match(/^(\d{4})-(\d{1,2})$/);
      if (ym) {
        const mm = String(Number(ym[2])).padStart(2, "0");
        current.periodStart = `${ym[1]}-${mm}-01`;
        current.periodEnd = `${ym[1]}-${mm}-28`;
      }
    }
  }

  flush();

  if (records.length === 0) throw new Error("bill-usage CSVから必要項目（期間/使用量）を抽出できませんでした");
  return records;
}
