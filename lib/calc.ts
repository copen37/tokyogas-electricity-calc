import plansData from "@/output/plans.json";
import unitPricesData from "@/output/unit_prices_template.json";

export type GasMode = "both" | "with" | "without";
export type ContractType = "ampere" | "kva" | "kw";
export type VariableUnitMode = "single_month_end" | "prorated_by_day";

export type UsageInput = {
  totalKwh: number;
  dayKwh?: number;
  nightKwh?: number;
};

type Plan = (typeof plansData)["plans"][number];

type Inputs = {
  contractType: ContractType;
  contractValue: number;
  yearMonth: string;
  usage: UsageInput;
  gasMode: GasMode;
  periodStartDate?: string;
  periodEndDate?: string;
  variableUnitMode?: VariableUnitMode;
};

export type Result = {
  planId: string;
  name: string;
  totalFloorYen: number;
  totalYen: number;
  breakdown: {
    base: number;
    energy: number;
    energyTier1?: number;
    energyTier2?: number;
    energyTier3?: number;
    discount: number;
    fuel: number;
    renewable: number;
    gov: number;
  };
  diagnostics: {
    usageKwh: number;
    yearMonth: string;
    periodDays: number | null;
    variableUnitMode: VariableUnitMode;
    variableUnitMonths: Array<{ month: string; days: number; fuel: number; gov: number; renewable: number }>;
  };
};

type VariableUnit = { fuel: number; gov: number; renewable: number };

function monthToFy(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const fy = m >= 5 ? y : y - 1;
  return `FY${fy}`;
}

function loadVariableUnitForMonth(yearMonth: string): VariableUnit {
  const monthMap = (unitPricesData as any).monthly_adjustments ?? {};
  const current = monthMap[yearMonth] ?? {};
  const annualLevies = (unitPricesData as any).annual_levies ?? {};
  const levy = annualLevies[monthToFy(yearMonth)] ?? Object.values(annualLevies)[0] ?? {};

  return {
    fuel: Number(current.fuel_adjustment_yen_per_kwh ?? 0),
    gov: Number(current.gov_support_yen_per_kwh ?? 0),
    renewable: Number(levy.renewable_surcharge_yen_per_kwh ?? 0)
  };
}

function ymdToMonth(ymd: string): string {
  return ymd.slice(0, 7);
}

function parseYmdJst(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00+09:00`);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function formatYmdJst(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function variableUnitsByPeriod(input: Inputs): {
  periodDays: number | null;
  mode: VariableUnitMode;
  monthBreakdown: Array<{ month: string; days: number; fuel: number; gov: number; renewable: number }>;
  weightedUnit: VariableUnit;
} {
  const mode = input.variableUnitMode ?? "single_month_end";
  const start = input.periodStartDate ? parseYmdJst(input.periodStartDate) : null;
  const end = input.periodEndDate ? parseYmdJst(input.periodEndDate) : null;

  if (!start || !end || end.getTime() < start.getTime()) {
    const u = loadVariableUnitForMonth(input.yearMonth);
    return {
      periodDays: null,
      mode,
      monthBreakdown: [{ month: input.yearMonth, days: 0, ...u }],
      weightedUnit: u
    };
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.floor((end.getTime() - start.getTime()) / oneDayMs) + 1;

  if (mode === "single_month_end") {
    const endMonth = ymdToMonth(input.periodEndDate!);
    const u = loadVariableUnitForMonth(endMonth);
    return {
      periodDays: totalDays,
      mode,
      monthBreakdown: [{ month: endMonth, days: totalDays, ...u }],
      weightedUnit: u
    };
  }

  const monthDays = new Map<string, number>();
  for (let i = 0; i < totalDays; i++) {
    const day = new Date(start.getTime() + i * oneDayMs);
    const month = ymdToMonth(formatYmdJst(day));
    monthDays.set(month, (monthDays.get(month) ?? 0) + 1);
  }

  const monthBreakdown = [...monthDays.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, days]) => {
    const u = loadVariableUnitForMonth(month);
    return { month, days, ...u };
  });

  let fuel = 0;
  let gov = 0;
  let renewable = 0;
  for (const m of monthBreakdown) {
    const ratio = m.days / totalDays;
    fuel += m.fuel * ratio;
    gov += m.gov * ratio;
    renewable += m.renewable * ratio;
  }

  return {
    periodDays: totalDays,
    mode,
    monthBreakdown,
    weightedUnit: { fuel, gov, renewable }
  };
}

function tieredChargeBreakdown(usageKwh: number, tiers: any[]): { total: number; amounts: number[] } {
  let rem = usageKwh;
  let prev = 0;
  let total = 0;
  const amounts: number[] = [];

  for (const t of tiers) {
    const upper = t.up_to_kwh;
    const rate = Number(t.rate);
    const block = upper == null ? Math.max(rem, 0) : Math.max(Math.min(rem, Number(upper) - prev), 0);
    const amt = block * rate;
    amounts.push(amt);
    total += amt;
    rem -= block;
    if (rem <= 0) break;
    if (upper != null) prev = Number(upper);
  }
  return { total, amounts };
}

function resolveSeason(yearMonth: string): "summer" | "other" {
  const m = Number(yearMonth.split("-")[1]);
  return [7, 8, 9].includes(m) ? "summer" : "other";
}

function inRange(v: number, min?: number, max?: number): boolean {
  const lo = min ?? Number.NEGATIVE_INFINITY;
  const hi = max ?? Number.POSITIVE_INFINITY;
  return v >= lo && v <= hi;
}

function isApplicable(plan: Plan, contractType: ContractType, contractValue: number): boolean {
  const c = plan.contract as any;
  const ct = c.type;

  if (ct === "ampere") return contractType === "ampere" && (c.ampere_options ?? []).includes(contractValue);
  if (ct === "kva") return contractType === "kva" && inRange(contractValue, Number(c.kva_min), Number(c.kva_max));
  if (ct === "kw") return contractType === "kw" && inRange(contractValue, Number(c.kw_min), Number(c.kw_max));
  if (ct === "ampere_or_kva") {
    if (contractType === "ampere") return (c.ampere_options ?? []).includes(contractValue);
    if (contractType === "kva") return inRange(contractValue, Number(c.kva_min), Number(c.kva_max));
    return false;
  }
  return false;
}

function baseCharge(plan: Plan, usageKwh: number, contractType: ContractType, contractValue: number): number {
  const base = plan.base_charge as any;
  let b = NaN;

  if (contractType === "ampere") b = Number(base.ampere_table?.[String(contractValue)] ?? NaN);
  else if (contractType === "kva") b = Number(base.per_kva ?? NaN) * contractValue;
  else if (contractType === "kw") b = Number(base.per_kw ?? NaN) * contractValue;

  if (!Number.isFinite(b) || b <= 0) return NaN;
  const adjusted = usageKwh <= 0 ? b * Number(base.zero_usage_base_ratio ?? 1) : b;
  const minimum = Number(base.minimum_monthly_charge ?? 0);
  return Math.max(adjusted, minimum);
}

function applyDiscount(plan: Plan, subtotal: number, base: number, usageKwh: number, hasGas: boolean): [number, number] {
  if (!hasGas) return [subtotal, 0];

  if ((plan as any).gas_discount_yen_per_month != null) {
    const d = Number((plan as any).gas_discount_yen_per_month);
    return [Math.max(subtotal - d, 0), d];
  }

  if ((plan as any).discount_yen_per_kwh != null) {
    const d = Number((plan as any).discount_yen_per_kwh) * usageKwh;
    return [Math.max(subtotal - d, 0), d];
  }

  const disc = (plan as any).set_discount ?? {};
  const t = disc.type;
  const v = disc.value;
  if (v == null) return [subtotal, 0];

  let d = 0;
  if (t === "percent_total") d = subtotal * Number(v);
  else if (t === "fixed_from_total") d = Number(v);
  else if (t === "fixed_from_base") d = Math.min(Number(v), base);

  const cap = Number(disc.max_discount_yen ?? NaN);
  if (Number.isFinite(cap)) d = Math.min(d, cap);

  return [Math.max(subtotal - d, 0), d];
}

function energyCharge(plan: Plan, usage: UsageInput, yearMonth: string, contractKw = 1): { total: number; tiers?: number[] } {
  const ec: any = plan.energy_charge;
  if (ec.mode === "tiered") {
    const out = tieredChargeBreakdown(usage.totalKwh, ec.tiers);
    return { total: out.total, tiers: out.amounts };
  }
  if (ec.mode === "seasonal_tiered") {
    const tiers = ec.seasonal[resolveSeason(yearMonth)].tiers.map((t: any) => ({
      up_to_kwh: t.up_to_formula === "contract_kw*130" ? contractKw * 130 : t.up_to_kwh,
      rate: t.rate
    }));
    const out = tieredChargeBreakdown(usage.totalKwh, tiers);
    return { total: out.total, tiers: out.amounts };
  }
  if (ec.mode === "time_of_use") {
    if (typeof usage.dayKwh === "number" && typeof usage.nightKwh === "number") {
      const dayRate = Number(ec.time_bands?.day?.rate ?? 0);
      const nightRate = Number(ec.time_bands?.night?.rate ?? 0);
      return { total: usage.dayKwh * dayRate + usage.nightKwh * nightRate };
    }
    return { total: usage.totalKwh * Number(ec.assumed_average_rate_when_no_interval ?? 0) };
  }
  return { total: NaN };
}

function calcOne(plan: Plan, input: Inputs, hasGas: boolean): Result | null {
  if (!isApplicable(plan, input.contractType, input.contractValue)) return null;

  const base = baseCharge(plan, input.usage.totalKwh, input.contractType, input.contractValue);
  const contractKw = input.contractType === "kw" ? input.contractValue : 1;
  const energyDetail = energyCharge(plan, input.usage, input.yearMonth, contractKw);
  const energy = energyDetail.total;
  if (!Number.isFinite(base) || !Number.isFinite(energy)) return null;

  const subtotal = base + energy;
  const [afterDiscount, discount] = applyDiscount(plan, subtotal, base, input.usage.totalKwh, hasGas);

  const units = variableUnitsByPeriod(input);
  const fuel = input.usage.totalKwh * units.weightedUnit.fuel;
  const renewable = input.usage.totalKwh * units.weightedUnit.renewable;
  const gov = input.usage.totalKwh * units.weightedUnit.gov;
  const total = afterDiscount + fuel + renewable - gov;

  return {
    planId: plan.id,
    name: plan.name,
    totalFloorYen: Math.floor(total),
    totalYen: total,
    breakdown: {
      base,
      energy,
      energyTier1: energyDetail.tiers?.[0],
      energyTier2: energyDetail.tiers?.[1],
      energyTier3: energyDetail.tiers?.[2],
      discount,
      fuel,
      renewable,
      gov
    },
    diagnostics: {
      usageKwh: input.usage.totalKwh,
      yearMonth: input.yearMonth,
      periodDays: units.periodDays,
      variableUnitMode: units.mode,
      variableUnitMonths: units.monthBreakdown
    }
  };
}

export function calculate(input: Inputs): { withGas: Result[]; withoutGas: Result[] } {
  const plans = plansData.plans;
  const withGas = input.gasMode === "without" ? [] : plans.map((p) => calcOne(p, input, true)).filter(Boolean) as Result[];
  const withoutGas = input.gasMode === "with" ? [] : plans.map((p) => calcOne(p, input, false)).filter(Boolean) as Result[];

  withGas.sort((a, b) => a.totalFloorYen - b.totalFloorYen);
  withoutGas.sort((a, b) => a.totalFloorYen - b.totalFloorYen);

  return { withGas, withoutGas };
}
