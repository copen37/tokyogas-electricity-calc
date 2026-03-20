import plansData from "@/output/plans.json";
import unitPricesData from "@/output/unit_prices_template.json";

export type GasMode = "both" | "with" | "without";

type Plan = (typeof plansData)["plans"][number];

type Inputs = {
  contractAmpere: number;
  yearMonth: string;
  usageKwh: number;
  gasMode: GasMode;
};

type Result = {
  planId: string;
  name: string;
  totalFloorYen: number;
  totalYen: number;
  breakdown: {
    base: number;
    energy: number;
    discount: number;
    fuel: number;
    renewable: number;
    gov: number;
  };
};

function monthToFy(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const fy = m >= 5 ? y : y - 1;
  return `FY${fy}`;
}

function loadVariableUnits(yearMonth: string) {
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

function tieredCharge(usageKwh: number, tiers: any[]): number {
  let rem = usageKwh;
  let prev = 0;
  let cost = 0;
  for (const t of tiers) {
    const upper = t.up_to_kwh;
    const rate = Number(t.rate);
    const block = upper == null ? Math.max(rem, 0) : Math.max(Math.min(rem, Number(upper) - prev), 0);
    cost += block * rate;
    rem -= block;
    if (rem <= 0) break;
    if (upper != null) prev = Number(upper);
  }
  return cost;
}

function resolveSeason(yearMonth: string): "summer" | "other" {
  const m = Number(yearMonth.split("-")[1]);
  return [7, 8, 9].includes(m) ? "summer" : "other";
}

function baseCharge(plan: Plan, usageKwh: number, contractAmpere: number): number {
  const base = plan.base_charge as any;
  const b = Number(base.ampere_table?.[String(contractAmpere)] ?? 0);
  if (b <= 0) return NaN;
  return usageKwh <= 0 ? b * Number(base.zero_usage_base_ratio ?? 1) : b;
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

  return [Math.max(subtotal - d, 0), d];
}

function energyCharge(plan: Plan, usageKwh: number, yearMonth: string, contractKw = 1): number {
  const ec: any = plan.energy_charge;
  if (ec.mode === "tiered") return tieredCharge(usageKwh, ec.tiers);
  if (ec.mode === "seasonal_tiered") {
    const tiers = ec.seasonal[resolveSeason(yearMonth)].tiers.map((t: any) => ({
      up_to_kwh: t.up_to_formula === "contract_kw*130" ? contractKw * 130 : t.up_to_kwh,
      rate: t.rate
    }));
    return tieredCharge(usageKwh, tiers);
  }
  if (ec.mode === "time_of_use") return usageKwh * Number(ec.assumed_average_rate_when_no_interval ?? 0);
  return NaN;
}

function isApplicable(plan: Plan, contractAmpere: number): boolean {
  const ct = (plan.contract as any).type;
  const c = plan.contract as any;
  if (ct === "ampere" || ct === "ampere_or_kva") return (c.ampere_options ?? []).includes(contractAmpere);
  return false;
}

function calcOne(plan: Plan, input: Inputs, hasGas: boolean): Result | null {
  if (!isApplicable(plan, input.contractAmpere)) return null;
  const base = baseCharge(plan, input.usageKwh, input.contractAmpere);
  const energy = energyCharge(plan, input.usageKwh, input.yearMonth);
  if (!Number.isFinite(base) || !Number.isFinite(energy)) return null;

  const subtotal = base + energy;
  const [afterDiscount, discount] = applyDiscount(plan, subtotal, base, input.usageKwh, hasGas);
  const unit = loadVariableUnits(input.yearMonth);

  const fuel = input.usageKwh * unit.fuel;
  const renewable = input.usageKwh * unit.renewable;
  const gov = input.usageKwh * unit.gov;
  const total = afterDiscount + fuel + renewable - gov;

  return {
    planId: plan.id,
    name: plan.name,
    totalFloorYen: Math.floor(total),
    totalYen: total,
    breakdown: { base, energy, discount, fuel, renewable, gov }
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
