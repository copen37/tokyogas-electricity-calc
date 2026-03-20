#!/usr/bin/env python3
import argparse
import csv
import json
import math
from datetime import datetime
from statistics import median
from typing import Dict, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Tokyo Gas bill calculator / plan comparator")
    p.add_argument("--plans", default="plans.json", help="Path to plans.json")
    p.add_argument("--unit-prices", default="unit_prices_template.json", help="Path to monthly variable unit prices")

    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--compare-plans", action="store_true", help="Compare all applicable plans")
    mode.add_argument("--plan", help="Single plan id")

    p.add_argument("--usage-kwh", type=float, help="Monthly usage kWh (flat calculation)")
    p.add_argument("--csv", help="Interval usage CSV")
    p.add_argument("--timestamp-col", default="timestamp")
    p.add_argument("--power-col", default="power")
    p.add_argument("--power-unit", choices=["W", "kW", "Wh", "kWh"], default="W")
    p.add_argument("--dt-minutes", type=float, help="Force interval minutes when unit=W/kW")

    p.add_argument("--year-month", default=datetime.now().strftime("%Y-%m"), help="YYYY-MM for variable unit prices")
    p.add_argument("--season", choices=["summer", "other", "auto"], default="auto", help="zuttomo3 seasonal band")

    p.add_argument("--contract-ampere", type=int)
    p.add_argument("--contract-kva", type=float)
    p.add_argument("--contract-kw", type=float)

    p.add_argument("--gas-mode", choices=["both", "with", "without"], default="both", help="Comparison gas scenario")
    p.add_argument("--has-gas", choices=["true", "false"], help="Single-plan mode gas setting")

    p.add_argument("--set-discount-rate", type=float, help="Override gas discount rate")
    p.add_argument("--set-discount-fixed", type=float, help="Override gas discount fixed yen/month")

    p.add_argument("--top", type=int, default=10)
    return p.parse_args()


def parse_ts(s: str) -> datetime:
    s = s.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                pass
    raise ValueError(f"Unsupported timestamp format: {s}")


def estimate_dt_minutes_from_timestamps(timestamps: List[datetime]) -> float:
    if len(timestamps) < 2:
        raise ValueError("Need at least 2 timestamps to infer interval")
    ts = sorted(timestamps)
    deltas = []
    for i in range(1, len(ts)):
        d = (ts[i] - ts[i - 1]).total_seconds() / 60.0
        if d > 0:
            deltas.append(d)
    if not deltas:
        raise ValueError("Could not infer positive interval")
    return median(deltas)


def parse_csv_records(csv_path: str, ts_col: str, power_col: str, power_unit: str, dt_minutes: Optional[float]):
    records = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if not row.get(ts_col):
                continue
            ts = parse_ts(row[ts_col])
            v_raw = row.get(power_col)
            if v_raw in (None, ""):
                continue
            v = float(v_raw)
            records.append((ts, v))

    if not records:
        return [], 0.0

    inferred_dt = dt_minutes
    if power_unit in ("W", "kW") and inferred_dt is None:
        inferred_dt = estimate_dt_minutes_from_timestamps([x[0] for x in records])

    usage_entries = []
    total_kwh = 0.0
    for ts, v in records:
        if power_unit == "W":
            if inferred_dt is None:
                raise ValueError("--dt-minutes required for W")
            kwh = (v / 1000.0) * (inferred_dt / 60.0)
        elif power_unit == "kW":
            if inferred_dt is None:
                raise ValueError("--dt-minutes required for kW")
            kwh = v * (inferred_dt / 60.0)
        elif power_unit == "Wh":
            kwh = v / 1000.0
        else:  # kWh
            kwh = v
        usage_entries.append((ts, kwh))
        total_kwh += kwh

    return usage_entries, total_kwh


def is_night_band(ts: datetime) -> bool:
    h = ts.hour
    return 1 <= h < 6


def split_time_of_use(usage_entries: List[Tuple[datetime, float]]) -> Dict[str, float]:
    out = {"day_kwh": 0.0, "night_kwh": 0.0}
    for ts, kwh in usage_entries:
        if is_night_band(ts):
            out["night_kwh"] += kwh
        else:
            out["day_kwh"] += kwh
    return out


def tiered_charge(usage_kwh: float, tiers: List[dict]) -> float:
    rem = usage_kwh
    prev = 0.0
    cost = 0.0
    for t in tiers:
        upper = t.get("up_to_kwh")
        rate = float(t["rate"])
        if upper is None:
            block = max(rem, 0.0)
        else:
            block = max(min(rem, float(upper) - prev), 0.0)
        cost += block * rate
        rem -= block
        if rem <= 0:
            break
        if upper is not None:
            prev = float(upper)
    return cost


def eval_formula(formula: str, contract_kw: Optional[float]) -> float:
    if formula == "contract_kw*130":
        if contract_kw is None:
            raise ValueError("contract_kw required")
        return contract_kw * 130
    raise ValueError(f"Unsupported formula: {formula}")


def seasonal_tiered_charge(usage_kwh: float, tiers: List[dict], contract_kw: Optional[float]) -> float:
    normalized = []
    for t in tiers:
        up = t.get("up_to_kwh")
        if up is None and t.get("up_to_formula"):
            up = eval_formula(t["up_to_formula"], contract_kw)
        normalized.append({"up_to_kwh": up, "rate": float(t["rate"])})
    return tiered_charge(usage_kwh, normalized)


def base_charge(plan: dict, usage_kwh: float, contract_ampere: Optional[int], contract_kva: Optional[float], contract_kw: Optional[float]) -> float:
    base = plan["base_charge"]
    if "ampere_table" in base and contract_ampere is not None:
        b = base["ampere_table"].get(str(contract_ampere))
        if b is None:
            raise ValueError(f"Plan {plan['id']}: unsupported ampere {contract_ampere}")
        b = float(b)
    elif "per_kva" in base and contract_kva is not None:
        b = float(base["per_kva"]) * contract_kva
    elif "per_kw" in base and contract_kw is not None:
        b = float(base["per_kw"]) * contract_kw
    else:
        raise ValueError(f"Plan {plan['id']}: missing contract parameter")

    if usage_kwh <= 0:
        return b * float(base.get("zero_usage_base_ratio", 1.0))
    return b


def apply_discount(plan: dict, subtotal: float, base_yen: float, usage_kwh: float, has_gas: bool,
                   override_rate: Optional[float], override_fixed: Optional[float]) -> Tuple[float, float]:
    if not has_gas:
        return subtotal, 0.0

    if override_rate is not None:
        d = subtotal * override_rate
        return max(subtotal - d, 0.0), d
    if override_fixed is not None:
        d = override_fixed
        return max(subtotal - d, 0.0), d

    if plan.get("gas_discount_yen_per_month") is not None:
        d = float(plan["gas_discount_yen_per_month"])
        return max(subtotal - d, 0.0), d
    if plan.get("discount_yen_per_kwh") is not None:
        d = float(plan["discount_yen_per_kwh"]) * usage_kwh
        return max(subtotal - d, 0.0), d

    disc = plan.get("set_discount") or {}
    t = disc.get("type")
    v = disc.get("value")
    if v is None:
        return subtotal, 0.0
    if t == "percent_total":
        d = subtotal * float(v)
    elif t == "fixed_from_total":
        d = float(v)
    elif t == "fixed_from_base":
        d = min(float(v), base_yen)
    else:
        d = 0.0
    return max(subtotal - d, 0.0), d


def month_to_fy(ym: str) -> str:
    y, m = [int(x) for x in ym.split("-")]
    fy = y if m >= 5 else y - 1
    return f"FY{fy}"


def load_variable_units(path: str, year_month: str) -> Dict[str, float]:
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    default = d.get("monthly_adjustments", {}).get("default", {})
    month_map = d.get("monthly_adjustments", {}).get("months", {})
    m = dict(default)
    m.update(month_map.get(year_month, {}))

    levy_default = d.get("annual_levies", {}).get("default", {})
    levy = dict(levy_default)
    levy.update(d.get("annual_levies", {}).get(month_to_fy(year_month), {}))

    return {
        "fuel_adjustment_yen_per_kwh": float(m.get("fuel_adjustment_yen_per_kwh", 0.0)),
        "gov_support_yen_per_kwh": float(m.get("gov_support_yen_per_kwh", 0.0)),
        "renewable_surcharge_yen_per_kwh": float(levy.get("renewable_surcharge_yen_per_kwh", 0.0)),
    }


def resolve_season(year_month: str, season_arg: str) -> str:
    if season_arg != "auto":
        return season_arg
    m = int(year_month.split("-")[1])
    return "summer" if m in (7, 8, 9) else "other"


def calc_energy(plan: dict, usage_kwh: float, usage_entries: List[Tuple[datetime, float]], year_month: str, contract_kw: Optional[float], season_arg: str) -> Tuple[float, Dict[str, float]]:
    ec = plan["energy_charge"]
    detail = {}
    if ec.get("mode") == "tiered":
        e = tiered_charge(usage_kwh, ec["tiers"])
    elif ec.get("mode") == "seasonal_tiered":
        season = resolve_season(year_month, season_arg)
        e = seasonal_tiered_charge(usage_kwh, ec["seasonal"][season]["tiers"], contract_kw)
        detail["season"] = season
    elif ec.get("mode") == "time_of_use":
        if usage_entries:
            parts = split_time_of_use(usage_entries)
            day = parts["day_kwh"] * float(ec["time_bands"]["day"]["rate"])
            night = parts["night_kwh"] * float(ec["time_bands"]["night"]["rate"])
            e = day + night
            detail.update(parts)
            detail["time_calc"] = "from_csv_timestamp"
        else:
            avg = float(ec.get("assumed_average_rate_when_no_interval", 0.0))
            e = usage_kwh * avg
            detail["time_calc"] = "assumed_average_rate"
            detail["assumed_average_rate"] = avg
    else:
        raise ValueError(f"Unsupported energy mode: {ec.get('mode')}")
    return e, detail


def calc_plan(plan: dict, usage_kwh: float, usage_entries: List[Tuple[datetime, float]], year_month: str,
              contract_ampere: Optional[int], contract_kva: Optional[float], contract_kw: Optional[float], season_arg: str,
              has_gas: bool, override_rate: Optional[float], override_fixed: Optional[float], variable_units: Dict[str, float]) -> Dict:
    b = base_charge(plan, usage_kwh, contract_ampere, contract_kva, contract_kw)
    e, e_detail = calc_energy(plan, usage_kwh, usage_entries, year_month, contract_kw, season_arg)

    subtotal = b + e
    after_discount, discount = apply_discount(plan, subtotal, b, usage_kwh, has_gas, override_rate, override_fixed)

    fuel = usage_kwh * variable_units["fuel_adjustment_yen_per_kwh"]
    renewable = usage_kwh * variable_units["renewable_surcharge_yen_per_kwh"]
    gov = usage_kwh * variable_units["gov_support_yen_per_kwh"]

    total = after_discount + fuel + renewable - gov
    total_floor = math.floor(total)

    return {
        "plan_id": plan["id"],
        "name": plan["name"],
        "status": plan.get("status"),
        "price_basis_label": plan.get("price_basis_label", "税込想定"),
        "base_yen": b,
        "energy_yen": e,
        "discount_yen": discount,
        "subtotal_yen": subtotal,
        "after_discount_yen": after_discount,
        "fuel_adjustment_yen": fuel,
        "renewable_surcharge_yen": renewable,
        "gov_support_discount_yen": gov,
        "total_yen": total,
        "total_floor_yen": total_floor,
        "energy_detail": e_detail,
    }


def is_applicable(plan: dict, contract_ampere: Optional[int], contract_kva: Optional[float], contract_kw: Optional[float]) -> bool:
    ct = plan["contract"]["type"]
    c = plan["contract"]
    if ct == "ampere":
        return contract_ampere in c.get("ampere_options", [])
    if ct == "kva":
        return contract_kva is not None and c["kva_min"] <= contract_kva < c["kva_max"]
    if ct == "kw":
        return contract_kw is not None and c["kw_min"] <= contract_kw < c["kw_max"]
    if ct == "ampere_or_kva":
        ok_a = contract_ampere in c.get("ampere_options", []) if contract_ampere is not None else False
        ok_k = contract_kva is not None and c["kva_min"] <= contract_kva < c["kva_max"]
        return ok_a or ok_k
    return False


def run_scenario(plans: List[dict], usage_kwh: float, usage_entries: List[Tuple[datetime, float]], args: argparse.Namespace,
                 has_gas: bool, variable_units: Dict[str, float]) -> List[Dict]:
    out = []
    for p in plans:
        if not is_applicable(p, args.contract_ampere, args.contract_kva, args.contract_kw):
            continue
        out.append(calc_plan(
            p, usage_kwh, usage_entries, args.year_month,
            args.contract_ampere, args.contract_kva, args.contract_kw, args.season,
            has_gas, args.set_discount_rate, args.set_discount_fixed, variable_units
        ))
    out.sort(key=lambda x: x["total_floor_yen"])
    return out


def print_results_block(title: str, results: List[Dict], top: int):
    print(f"--- {title} ---")
    if not results:
        print("No applicable plans")
        return
    for i, r in enumerate(results[:top], 1):
        print(
            f"{i:>2}. {r['plan_id']:<14} {r['name']:<14} total={r['total_floor_yen']:>8}円 "
            f"[{r['price_basis_label']}] "
            f"(base={r['base_yen']:.2f}, energy={r['energy_yen']:.2f}, discount={r['discount_yen']:.2f}, "
            f"fuel={r['fuel_adjustment_yen']:.2f}, renewable={r['renewable_surcharge_yen']:.2f}, gov={r['gov_support_discount_yen']:.2f})"
        )
    best = results[0]
    print(f"BEST_PLAN[{title}] {best['plan_id']} {best['total_floor_yen']}円")


def main():
    args = parse_args()

    with open(args.plans, encoding="utf-8") as f:
        data = json.load(f)
    plans = data["plans"]

    if args.usage_kwh is None and not args.csv:
        raise SystemExit("Specify either --usage-kwh or --csv")

    usage_entries: List[Tuple[datetime, float]] = []
    inferred_usage = None
    if args.csv:
        usage_entries, inferred_usage = parse_csv_records(
            args.csv, args.timestamp_col, args.power_col, args.power_unit, args.dt_minutes
        )
    usage_kwh = args.usage_kwh if args.usage_kwh is not None else inferred_usage

    if usage_kwh is None:
        raise SystemExit("Could not determine usage_kwh")

    variable_units = load_variable_units(args.unit_prices, args.year_month)

    print("=== Tokyo Gas Plan Comparison ===")
    print(f"usage_kwh={usage_kwh:.3f} year_month={args.year_month}")
    print(f"contract: ampere={args.contract_ampere}, kva={args.contract_kva}, kw={args.contract_kw}, season={args.season}")
    print(
        "variable_units: "
        f"fuel={variable_units['fuel_adjustment_yen_per_kwh']}円/kWh, "
        f"renewable={variable_units['renewable_surcharge_yen_per_kwh']}円/kWh, "
        f"gov_support={variable_units['gov_support_yen_per_kwh']}円/kWh"
    )
    print("rounding: 合計は円未満切り捨て")
    print("")

    if args.compare_plans:
        if args.gas_mode in ("both", "with"):
            with_results = run_scenario(plans, usage_kwh, usage_entries, args, True, variable_units)
            print_results_block("has_gas=true", with_results, args.top)
            print("")
        if args.gas_mode in ("both", "without"):
            without_results = run_scenario(plans, usage_kwh, usage_entries, args, False, variable_units)
            print_results_block("has_gas=false", without_results, args.top)
            print("")
        if args.gas_mode == "both":
            if with_results:
                print(f"ガスあり最安: {with_results[0]['plan_id']} {with_results[0]['total_floor_yen']}円")
            if without_results:
                print(f"ガスなし最安: {without_results[0]['plan_id']} {without_results[0]['total_floor_yen']}円")
        return

    if args.has_gas is None:
        raise SystemExit("Single plan mode requires --has-gas true|false")
    target = [p for p in plans if p["id"] == args.plan]
    if not target:
        raise SystemExit(f"plan not found: {args.plan}")

    results = run_scenario(target, usage_kwh, usage_entries, args, args.has_gas == "true", variable_units)
    if not results:
        raise SystemExit("No applicable plan for given contract condition")
    print_results_block(f"has_gas={args.has_gas}", results, 1)


if __name__ == "__main__":
    main()
