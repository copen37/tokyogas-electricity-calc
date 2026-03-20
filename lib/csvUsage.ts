export type PowerUnit = "W" | "kW" | "Wh" | "kWh";

export type MonthlyUsage = {
  month: string;
  totalKwh: number;
  dayKwh: number;
  nightKwh: number;
};

type Row = {
  timestamp: string;
  power: number;
  epochMs: number;
  month: string;
  minuteOfDay: number;
};

function hasOffset(ts: string): boolean {
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(ts.trim());
}

function normalizeYmdh(ts: string): string | null {
  const m = ts.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00`;
}

function parseEpochMs(ts: string): number {
  const ymdh = normalizeYmdh(ts);
  const base = ymdh ?? ts.trim();
  const normalized = base.includes(" ") && !base.includes("T") ? base.replace(" ", "T") : base;
  if (hasOffset(normalized)) return new Date(normalized).getTime();
  return new Date(`${normalized}+09:00`).getTime();
}

function minuteOfDayFromTimestamp(ts: string, epochMs: number): number {
  const ymdh = normalizeYmdh(ts);
  if (ymdh) return Number(ymdh.slice(11, 13)) * 60;

  const trimmed = ts.trim();
  const timeMatch = trimmed.match(/[T\s](\d{2}):(\d{2})/);
  if (timeMatch && hasOffset(trimmed)) {
    const h = Number(timeMatch[1]);
    const m = Number(timeMatch[2]);
    return h * 60 + m;
  }

  const d = new Date(epochMs);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

function monthFromTimestamp(ts: string, epochMs: number): string {
  const ymdh = normalizeYmdh(ts);
  if (ymdh) return `${ymdh.slice(0, 4)}-${ymdh.slice(5, 7)}`;

  const monthMatch = ts.trim().match(/^(\d{4}-\d{2})/);
  if (monthMatch && hasOffset(ts)) return monthMatch[1];

  const d = new Date(epochMs);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

function isNight(minuteOfDay: number): boolean {
  // 01:00-06:00
  return minuteOfDay >= 60 && minuteOfDay < 360;
}

function estimateDtMinutes(rows: Row[], index: number, prevDt: number): number {
  const current = rows[index];
  const next = rows[index + 1];
  if (next) {
    const dt = (next.epochMs - current.epochMs) / 60000;
    if (Number.isFinite(dt) && dt > 0 && dt <= 1440) return dt;
  }
  if (prevDt > 0) return prevDt;
  return 30;
}

function headerIndex(header: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

export function parseUsageCsv(text: string, unit: PowerUnit, maxRows = 200000): MonthlyUsage[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSVにデータ行がありません");

  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, ""));

  const tsIdx = headerIndex(header, ["timestamp", "計測日時", "日時", "time", "date"]);
  const powerIdx = headerIndex(header, ["power", "買電", "使用電力", "usage", "consumption"]);

  if (tsIdx < 0 || powerIdx < 0) {
    throw new Error("CSVヘッダは timestamp,power（または 計測日時,買電）が必要です");
  }

  const rows: Row[] = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(",");
    const timestamp = cols[tsIdx]?.trim();
    const powerRaw = cols[powerIdx]?.trim();
    if (!timestamp || !powerRaw || powerRaw === "-") continue;

    const p = Number(powerRaw);
    if (!Number.isFinite(p)) continue;

    const epochMs = parseEpochMs(timestamp);
    if (!Number.isFinite(epochMs)) continue;

    const minuteOfDay = minuteOfDayFromTimestamp(timestamp, epochMs);
    const month = monthFromTimestamp(timestamp, epochMs);
    rows.push({ timestamp, power: p, epochMs, month, minuteOfDay });
  }

  if (rows.length === 0) throw new Error("有効な行がありません");
  rows.sort((a, b) => a.epochMs - b.epochMs);

  const monthMap = new Map<string, MonthlyUsage>();
  let prevDt = 30;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dtMinutes = estimateDtMinutes(rows, i, prevDt);
    prevDt = dtMinutes;

    let kwh = 0;
    if (unit === "kWh") kwh = r.power;
    else if (unit === "Wh") kwh = r.power / 1000;
    else if (unit === "kW") kwh = r.power * (dtMinutes / 60);
    else if (unit === "W") kwh = (r.power / 1000) * (dtMinutes / 60);

    const bucket = monthMap.get(r.month) ?? { month: r.month, totalKwh: 0, dayKwh: 0, nightKwh: 0 };
    bucket.totalKwh += kwh;
    if (isNight(r.minuteOfDay)) bucket.nightKwh += kwh;
    else bucket.dayKwh += kwh;
    monthMap.set(r.month, bucket);
  }

  return [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month));
}
