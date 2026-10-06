"""
Build the sales dataset used by the dashboard.

Outputs (in ../data):
  - sales.csv    one row per order line (transaction grain)
  - targets.csv  monthly revenue targets per region

Business context: Nusantara Retail, an omnichannel retailer selling across
Indonesia through its own online store, marketplaces, physical stores and a
B2B sales team. Period: Jan 2023 - Dec 2025.

Run:  python scripts/build_dataset.py
Only the Python standard library is required. The seed is fixed, so the
output is reproducible.
"""

import csv
import math
import random
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

SEED = 20250101
START = date(2023, 1, 1)
END = date(2025, 12, 31)
OUT_DIR = Path(__file__).resolve().parent.parent / "data"

rng = random.Random(SEED)

# --------------------------------------------------------------------------
# Master data
# --------------------------------------------------------------------------

# region -> [(province, weight, [cities])]
GEO = {
    "Java": [
        ("DKI Jakarta", 16, ["Jakarta Selatan", "Jakarta Barat", "Jakarta Timur", "Jakarta Utara", "Jakarta Pusat"]),
        ("Jawa Barat", 14, ["Bandung", "Bekasi", "Depok", "Bogor", "Cirebon"]),
        ("Jawa Timur", 11, ["Surabaya", "Malang", "Sidoarjo", "Kediri"]),
        ("Jawa Tengah", 8, ["Semarang", "Solo", "Magelang", "Pekalongan"]),
        ("Banten", 6, ["Tangerang", "Tangerang Selatan", "Serang", "Cilegon"]),
        ("DI Yogyakarta", 3, ["Yogyakarta", "Sleman", "Bantul"]),
    ],
    "Sumatra": [
        ("Sumatera Utara", 5, ["Medan", "Binjai", "Pematangsiantar"]),
        ("Riau", 2.5, ["Pekanbaru", "Dumai"]),
        ("Sumatera Selatan", 2.5, ["Palembang", "Prabumulih"]),
        ("Sumatera Barat", 2, ["Padang", "Bukittinggi"]),
        ("Lampung", 2, ["Bandar Lampung", "Metro"]),
        ("Kepulauan Riau", 1.8, ["Batam", "Tanjung Pinang"]),
        ("Aceh", 1.2, ["Banda Aceh", "Lhokseumawe"]),
        ("Jambi", 1, ["Jambi"]),
        ("Kepulauan Bangka Belitung", 0.6, ["Pangkal Pinang"]),
        ("Bengkulu", 0.6, ["Bengkulu"]),
    ],
    "Kalimantan": [
        ("Kalimantan Timur", 2.5, ["Balikpapan", "Samarinda"]),
        ("Kalimantan Selatan", 1.6, ["Banjarmasin", "Banjarbaru"]),
        ("Kalimantan Barat", 1.5, ["Pontianak", "Singkawang"]),
        ("Kalimantan Tengah", 0.7, ["Palangka Raya"]),
        ("Kalimantan Utara", 0.3, ["Tarakan"]),
    ],
    "Sulawesi": [
        ("Sulawesi Selatan", 3.5, ["Makassar", "Parepare"]),
        ("Sulawesi Utara", 1.4, ["Manado", "Bitung"]),
        ("Sulawesi Tengah", 0.8, ["Palu"]),
        ("Sulawesi Tenggara", 0.7, ["Kendari"]),
        ("Gorontalo", 0.4, ["Gorontalo"]),
        ("Sulawesi Barat", 0.3, ["Mamuju"]),
    ],
    "Bali & Nusa Tenggara": [
        ("Bali", 3, ["Denpasar", "Badung", "Gianyar"]),
        ("Nusa Tenggara Barat", 1.2, ["Mataram"]),
        ("Nusa Tenggara Timur", 0.9, ["Kupang"]),
    ],
    "Maluku & Papua": [
        ("Papua", 0.7, ["Jayapura", "Timika"]),
        ("Maluku", 0.5, ["Ambon"]),
        ("Papua Barat", 0.4, ["Manokwari", "Sorong"]),
        ("Maluku Utara", 0.3, ["Ternate"]),
    ],
}
PROVINCES = [(reg, p, w, cities) for reg, plist in GEO.items() for (p, w, cities) in plist]
# Regional growth multipliers per year (Java mature, outer islands growing faster)
REGION_GROWTH = {
    "Java": 1.12, "Sumatra": 1.18, "Kalimantan": 1.24, "Sulawesi": 1.22,
    "Bali & Nusa Tenggara": 1.20, "Maluku & Papua": 1.28,
}

# category -> sub_category -> [(product, unit price IDR, base margin)]
CATALOG = {
    "Electronics": {
        "Smartphones": [("Galaxy A55 5G 8/256", 5_999_000, 0.12), ("Redmi Note 13 Pro 8/256", 3_899_000, 0.11),
                        ("iPhone 15 128GB", 13_999_000, 0.09), ("Oppo Reno 11 5G", 5_499_000, 0.12)],
        "Laptops": [("Vivobook 14 i5 16GB", 9_499_000, 0.10), ("IdeaPad Slim 3 Ryzen 5", 7_999_000, 0.10),
                    ("MacBook Air M2 13\"", 16_999_000, 0.08)],
        "Audio": [("Wireless Earbuds Pro", 899_000, 0.32), ("Bluetooth Speaker Mini", 549_000, 0.30),
                  ("Noise Cancelling Headphones", 2_499_000, 0.25)],
        "Accessories": [("65W GaN Charger", 329_000, 0.40), ("Power Bank 20000mAh", 289_000, 0.38),
                        ("USB-C Cable 2m", 89_000, 0.52), ("Smartwatch Fit 3", 1_299_000, 0.28)],
    },
    "Home & Living": {
        "Kitchenware": [("Air Fryer 4.5L", 899_000, 0.30), ("Rice Cooker Digital 1.8L", 649_000, 0.28),
                        ("Non-stick Pan Set", 459_000, 0.36), ("Blender 2-in-1", 399_000, 0.31)],
        "Furniture": [("Ergonomic Office Chair", 1_899_000, 0.27), ("Minimalist Study Desk", 1_249_000, 0.26),
                      ("3-Tier Bookshelf", 549_000, 0.30)],
        "Home Decor": [("LED Floor Lamp", 389_000, 0.42), ("Aromatherapy Diffuser", 249_000, 0.45),
                       ("Wall Clock Scandinavian", 159_000, 0.48)],
    },
    "Fashion": {
        "Men's Apparel": [("Oxford Shirt Slim Fit", 279_000, 0.50), ("Chino Pants", 329_000, 0.48),
                          ("Batik Shirt Premium", 449_000, 0.46)],
        "Women's Apparel": [("Modest Long Dress", 389_000, 0.50), ("Hijab Voal Premium", 129_000, 0.55),
                            ("Knit Cardigan", 259_000, 0.50)],
        "Footwear": [("Running Shoes Air", 899_000, 0.38), ("Canvas Sneakers", 399_000, 0.44),
                     ("Leather Loafers", 649_000, 0.40)],
    },
    "Health & Beauty": {
        "Skincare": [("Niacinamide Serum 30ml", 129_000, 0.58), ("Sunscreen SPF50 50ml", 89_000, 0.56),
                     ("Hydrating Moisturizer", 149_000, 0.57)],
        "Personal Care": [("Electric Toothbrush", 399_000, 0.40), ("Hair Dryer Ionic", 349_000, 0.38),
                          ("Body Wash Family Pack", 79_000, 0.35)],
    },
    "Groceries": {
        "Beverages": [("Premium Arabica Coffee 500g", 159_000, 0.24), ("Green Tea Box 50s", 49_000, 0.22),
                      ("UHT Milk 1L x12", 219_000, 0.12)],
        "Snacks": [("Mixed Nuts 500g", 119_000, 0.26), ("Chocolate Gift Box", 189_000, 0.30),
                   ("Rice Crackers Pack", 39_000, 0.25)],
    },
    "Office Supplies": {
        "Paper": [("A4 Copy Paper 80gsm (5 ream)", 289_000, 0.18), ("Sticky Notes Bundle", 49_000, 0.45)],
        "Stationery": [("Gel Pen Set 12", 69_000, 0.48), ("Executive Notebook A5", 99_000, 0.50),
                       ("Desk Organizer", 139_000, 0.44)],
        "Printers & Ink": [("Ink Tank Printer", 2_399_000, 0.14), ("Ink Bottle Set CMYK", 399_000, 0.35)],
    },
}

PRODUCTS = []
_pid = 1000
for cat, subs in CATALOG.items():
    for sub, items in subs.items():
        for name, price, margin in items:
            _pid += 1
            PRODUCTS.append({"product_id": f"P{_pid}", "category": cat, "sub_category": sub,
                             "product_name": name, "price": price, "margin": margin})

# Category popularity by channel/segment
CAT_WEIGHT = {
    "Consumer": {"Electronics": 14, "Home & Living": 19, "Fashion": 28, "Health & Beauty": 25, "Groceries": 14, "Office Supplies": 4},
    "SME": {"Electronics": 20, "Home & Living": 14, "Fashion": 8, "Health & Beauty": 6, "Groceries": 14, "Office Supplies": 32},
    "Corporate": {"Electronics": 26, "Home & Living": 18, "Fashion": 4, "Health & Beauty": 4, "Groceries": 10, "Office Supplies": 30},
}
SEGMENT_WEIGHT = {"Consumer": 74, "SME": 17, "Corporate": 9}
CHANNEL_BY_SEGMENT = {
    "Consumer": {"Marketplace": 46, "Online Store": 26, "Retail Store": 28, "B2B Sales": 0},
    "SME": {"Marketplace": 30, "Online Store": 25, "Retail Store": 15, "B2B Sales": 30},
    "Corporate": {"Marketplace": 5, "Online Store": 15, "Retail Store": 5, "B2B Sales": 75},
}
# channel mix drifts towards digital each year
CHANNEL_DRIFT = {"Marketplace": 1.10, "Online Store": 1.16, "Retail Store": 0.93, "B2B Sales": 1.04}
PAYMENT_BY_CHANNEL = {
    "Marketplace": {"E-Wallet": 38, "Bank Transfer": 18, "PayLater": 16, "COD": 18, "Credit Card": 10},
    "Online Store": {"E-Wallet": 32, "Bank Transfer": 26, "PayLater": 14, "Credit Card": 20, "COD": 8},
    "Retail Store": {"Cash": 30, "Debit Card": 30, "E-Wallet": 25, "Credit Card": 15},
    "B2B Sales": {"Bank Transfer": 80, "Credit Card": 20},
}
SHIP_BY_CHANNEL = {
    "Marketplace": {"Regular": 55, "Express": 35, "Same Day": 10},
    "Online Store": {"Regular": 45, "Express": 35, "Same Day": 20},
    "Retail Store": {"In-Store": 85, "Same Day": 15},
    "B2B Sales": {"Regular": 60, "Express": 40},
}
BASE_DAYS = {"In-Store": 0, "Same Day": 0, "Express": 1, "Regular": 3}
REGION_EXTRA_DAYS = {"Java": 0, "Sumatra": 1, "Bali & Nusa Tenggara": 1, "Kalimantan": 2, "Sulawesi": 2, "Maluku & Papua": 4}

# Ramadan windows (approx. 1 Ramadan -> Idul Fitri) and campaign days
RAMADAN = [(date(2023, 3, 23), date(2023, 4, 22)), (date(2024, 3, 11), date(2024, 4, 10)),
           (date(2025, 3, 1), date(2025, 3, 31))]
CAMPAIGN_DAYS = {(9, 9): 2.4, (10, 10): 2.0, (11, 11): 3.2, (12, 12): 2.8}


def wchoice(d):
    keys = list(d.keys())
    return rng.choices(keys, weights=[d[k] for k in keys], k=1)[0]


def day_factor(d):
    f = 1.0
    if d.weekday() >= 5:
        f *= 1.18
    if d.day >= 25 or d.day <= 2:          # payday
        f *= 1.15
    for a, b in RAMADAN:
        if a <= d <= b:
            # ramp up through Ramadan, peaking before Lebaran
            f *= 1.25 + 0.6 * ((d - a).days / (b - a).days)
        elif b < d <= b + timedelta(days=5):
            f *= 0.7                       # Lebaran holiday dip
    f *= CAMPAIGN_DAYS.get((d.month, d.day), 1.0)
    if d.month == 12:
        f *= 1.12
    if d.month in (1, 2):
        f *= 0.9
    return f


def campaign_discount(d):
    if (d.month, d.day) in CAMPAIGN_DAYS:
        return 0.15
    for a, b in RAMADAN:
        if a <= d <= b:
            return 0.06
    return 0.0


# --------------------------------------------------------------------------
# Customers
# --------------------------------------------------------------------------
customers = []          # dicts
first_names = ["Andi", "Budi", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hendra", "Intan", "Joko", "Kartika",
               "Lestari", "Made", "Nanda", "Oki", "Putri", "Rizky", "Sari", "Taufik", "Wulan", "Yusuf", "Zahra"]


def new_customer(d):
    seg = wchoice(SEGMENT_WEIGHT)
    reg, prov, _, cities = rng.choices(PROVINCES, weights=[p[2] * REGION_GROWTH[p[0]] ** ((d - START).days / 365)
                                                          for p in PROVINCES], k=1)[0]
    c = {
        "customer_id": f"C{len(customers) + 10001}",
        "segment": seg, "region": reg, "province": prov, "city": rng.choice(cities),
        "since": d,
        # loyalty propensity: a minority of customers buy very often
        "loyalty": rng.betavariate(1.2, 4.5) * (1.8 if seg != "Consumer" else 1.0),
    }
    customers.append(c)
    return c


def pick_customer(d):
    years = (d - START).days / 365
    p_new = max(0.22, 0.55 - 0.12 * years) if customers else 1.0
    if rng.random() < p_new:
        return new_customer(d)
    for _ in range(60):
        c = customers[rng.randrange(len(customers))]
        age = (d - c["since"]).days
        if rng.random() < c["loyalty"] * math.exp(-age / 520):
            return c
    return customers[rng.randrange(len(customers))]


# --------------------------------------------------------------------------
# Orders
# --------------------------------------------------------------------------
rows = []
order_no = 0
d = START
while d <= END:
    years = (d - START).days / 365
    expected = 10.0 * (1.17 ** years) * day_factor(d)
    n_orders = max(0, int(rng.gauss(expected, math.sqrt(expected))))
    for _ in range(n_orders):
        order_no += 1
        c = pick_customer(d)
        seg = c["segment"]
        ch_w = {k: v * CHANNEL_DRIFT[k] ** years for k, v in CHANNEL_BY_SEGMENT[seg].items()}
        channel = wchoice(ch_w)
        payment = wchoice(PAYMENT_BY_CHANNEL[channel])
        ship_mode = wchoice(SHIP_BY_CHANNEL[channel])
        if ship_mode == "Same Day" and c["region"] not in ("Java", "Bali & Nusa Tenggara"):
            ship_mode = "Express"
        delivery_days = 0 if ship_mode == "In-Store" else max(
            0, BASE_DAYS[ship_mode] + REGION_EXTRA_DAYS[c["region"]] + int(rng.gauss(0.5, 1.0)))
        order_id = f"NR-{d.year}-{order_no:06d}"
        n_lines = rng.choices([1, 2, 3, 4], weights=[62, 25, 9, 4])[0]
        if seg != "Consumer":
            n_lines = min(5, n_lines + rng.choice([0, 1]))
        camp = campaign_discount(d)
        returned_order = rng.random() < (0.045 if channel == "Marketplace" else 0.025)
        used = set()
        for _l in range(n_lines):
            cat = wchoice(CAT_WEIGHT[seg])
            if cat == "Fashion" and any(a <= d <= b for a, b in RAMADAN):
                cat = wchoice({"Fashion": 70, "Groceries": 30})
            p = rng.choice([x for x in PRODUCTS if x["category"] == cat])
            if p["product_id"] in used:
                continue
            used.add(p["product_id"])
            if seg == "Consumer":
                qty = rng.choices([1, 2, 3], weights=[78, 17, 5])[0]
            else:
                qty = rng.choices([1, 2, 5, 10, 20], weights=[20, 25, 25, 20, 10])[0]
                if p["price"] > 5_000_000:
                    qty = max(1, qty // 4)
            # price inflation ~3%/yr
            unit_price = round(p["price"] * (1.03 ** int(years)) / 1000) * 1000
            disc = camp
            if channel == "Marketplace":
                disc += rng.choice([0, 0, 0.05, 0.10])
            if seg != "Consumer" and qty >= 10:
                disc += 0.08
            if p["sub_category"] in ("Smartphones", "Laptops") and rng.random() < 0.25:
                disc += 0.05
            if rng.random() < 0.04:
                disc += rng.choice([0.2, 0.3])           # clearance
            disc = round(min(disc, 0.5), 2)
            sales = round(unit_price * qty * (1 - disc))
            cost = round(unit_price * (1 - p["margin"]) * qty * rng.uniform(0.97, 1.03))
            if channel == "Marketplace":
                cost += round(sales * 0.04)              # platform fee
            profit = sales - cost
            rows.append({
                "order_id": order_id, "order_date": d.isoformat(),
                "customer_id": c["customer_id"], "segment": seg,
                "channel": channel, "payment_method": payment, "ship_mode": ship_mode,
                "delivery_days": delivery_days,
                "region": c["region"], "province": c["province"], "city": c["city"],
                "product_id": p["product_id"], "category": p["category"], "sub_category": p["sub_category"],
                "product_name": p["product_name"],
                "quantity": qty, "unit_price": unit_price, "discount": disc,
                "sales": sales, "cost": cost, "profit": profit,
                "returned": 1 if returned_order else 0,
            })
    d += timedelta(days=1)

OUT_DIR.mkdir(exist_ok=True)
with open(OUT_DIR / "sales.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

# --------------------------------------------------------------------------
# Targets: set by finance at the start of each year = previous year's actual
# for that month & region x growth ambition (first year: smoothed baseline).
# --------------------------------------------------------------------------
actual = defaultdict(float)
for r in rows:
    actual[(r["order_date"][:7], r["region"])] += r["sales"]
targets = []
for (ym, reg), v in sorted(actual.items()):
    y, m = int(ym[:4]), int(ym[5:])
    prev = actual.get((f"{y - 1}-{m:02d}", reg))
    ambition = {2023: 1.0, 2024: 1.20, 2025: 1.22}[y]
    base = prev * ambition if prev else v * rng.uniform(0.92, 1.08)
    targets.append({"month": ym, "region": reg, "target_sales": round(base * rng.uniform(0.97, 1.05), -5)})
with open(OUT_DIR / "targets.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["month", "region", "target_sales"])
    w.writeheader()
    w.writerows(targets)

total = sum(r["sales"] for r in rows)
print(f"rows={len(rows):,} orders={order_no:,} customers={len(customers):,} revenue=Rp{total/1e9:,.1f}B")
