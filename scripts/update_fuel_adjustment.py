#!/usr/bin/env python3
"""Update Tokyo Gas fuel adjustment unit price for a target month.

Usage:
  python scripts/update_fuel_adjustment.py 2026-02
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import pdfplumber
import requests

BASE_URL = "https://home.tokyo-gas.co.jp/gas_power/plan/power/adjustment/pdf/"
JST = timezone(timedelta(hours=9))


def build_pdf_url(year_month: str) -> str:
    y, m = year_month.split("-")
    yy = y[-2:]
    mm = m.zfill(2)
    return f"{BASE_URL}chousei{yy}{mm}.pdf"


def check_status(url: str) -> int:
    r = requests.head(url, allow_redirects=True, timeout=20)
    if r.status_code == 405:
        r = requests.get(url, stream=True, allow_redirects=True, timeout=20)
    return r.status_code


def download_pdf(url: str, dest: Path) -> None:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)


def parse_first_number(text: str) -> Optional[float]:
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*円\s*/\s*kWh", text)
    return float(m.group(1)) if m else None


def extract_fuel_price(pdf_path: Path, year_month: str) -> float:
    # Pattern 1: region table row containing 東京電力エリア (new style)
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                for row in table:
                    if not row:
                        continue
                    cells = [c or "" for c in row]
                    row_text = " ".join(cells)
                    if "東京電力エリア" in row_text:
                        for cell in cells:
                            num = parse_first_number(cell)
                            if num is not None:
                                return num

    # Pattern 2: month row like "2026年2月分 燃料費調整単価 -12.22 円/kWh" (old style)
    y, m = year_month.split("-")
    month_token = f"{int(y)}年{int(m)}月分"
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                for row in table:
                    if not row:
                        continue
                    row_text = " ".join([(c or "") for c in row])
                    if month_token in row_text and "燃料費調整単価" in row_text:
                        num = parse_first_number(row_text)
                        if num is not None:
                            return num

    raise ValueError("東京電力エリア/低圧の燃料費調整単価を特定できませんでした")


def update_json(json_path: Path, year_month: str, fuel: Optional[float], source_url: str, note: str) -> None:
    data = json.loads(json_path.read_text(encoding="utf-8"))

    monthly = data.setdefault("monthly_adjustments", {})
    months = monthly.setdefault("months", {})

    # backward compatibility for existing flat map
    if year_month in monthly and isinstance(monthly[year_month], dict):
        base_obj = dict(monthly[year_month])
    else:
        base_obj = dict(months.get(year_month, {}))

    if "gov_support_yen_per_kwh" not in base_obj:
        base_obj["gov_support_yen_per_kwh"] = 0

    if fuel is not None:
        base_obj["fuel_adjustment_yen_per_kwh"] = fuel
    else:
        base_obj.setdefault("fuel_adjustment_yen_per_kwh", None)

    checked_at = datetime.now(JST).isoformat(timespec="seconds")
    base_obj["notes"] = f"source_url={source_url}; checked_at={checked_at}; {note}"

    months[year_month] = base_obj
    # keep flat key for compatibility with existing frontend code
    monthly[year_month] = base_obj

    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("year_month", help="YYYY-MM")
    parser.add_argument("--json", default="output/unit_prices_template.json", help="Path to unit_prices_template.json")
    args = parser.parse_args()

    if not re.fullmatch(r"\d{4}-\d{2}", args.year_month):
        raise SystemExit("year_month must be YYYY-MM")

    url = build_pdf_url(args.year_month)
    status = check_status(url)

    if status != 200:
        note = f"抽出不能: PDFが取得不可 (HTTP {status})"
        update_json(Path(args.json), args.year_month, None, url, note)
        print(json.dumps({"year_month": args.year_month, "url": url, "status": status, "updated": True, "fuel_adjustment": None, "note": note}, ensure_ascii=False))
        return

    pdf_path = Path("tmp_pdf") / f"chousei_{args.year_month}.pdf"
    download_pdf(url, pdf_path)

    try:
        fuel = extract_fuel_price(pdf_path, args.year_month)
        note = "東京電力エリアの表から抽出"
        update_json(Path(args.json), args.year_month, fuel, url, note)
        print(json.dumps({"year_month": args.year_month, "url": url, "status": status, "updated": True, "fuel_adjustment": fuel}, ensure_ascii=False))
    except Exception as e:
        note = f"抽出不能: {e}"
        update_json(Path(args.json), args.year_month, None, url, note)
        print(json.dumps({"year_month": args.year_month, "url": url, "status": status, "updated": True, "fuel_adjustment": None, "note": note}, ensure_ascii=False))


if __name__ == "__main__":
    main()
