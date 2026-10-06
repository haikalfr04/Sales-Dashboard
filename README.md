# Nusantara Retail — Sales Performance Dashboard

An interactive, Power BI / Looker Studio–style sales dashboard for an Indonesian omnichannel retailer. It covers revenue, profitability, target attainment, product mix, customer retention and regional performance across all 34 provinces.

![Sales overview](docs/overview.png)

> **Live demo:** after GitHub Pages is enabled (see [Deployment](#deployment)), the dashboard is available at
> `https://haikalfr04.github.io/Sales-Dashboard/`

---

## Business questions

| Page | Questions it answers |
|---|---|
| **Overview** | How is revenue trending against the prior period? Are we hitting the monthly plan? Which channels, categories and regions drive the business? |
| **Products** | What does the revenue mix look like? Which sub-categories lose money? Which products sell best? Does discounting hurt margin? |
| **Customers** | How many new vs. returning customers do we have each month? How well do acquisition cohorts retain? Which segments and payment methods matter? |
| **Regional** | Where are sales concentrated across Indonesia? Which regions grow fastest? How long does delivery take outside Java? |
| **Data** | Searchable, sortable order-line detail for the current filter context, exportable to CSV. |

## Features

- **Report pages and a global filter pane:** period presets (2023 / 2024 / 2025 / H2 / All), a custom month range, and multi-select slicers for Region, Category, Channel and Segment.
- **Cross-filtering:** click a bar, donut slice, treemap tile, map province or table row to filter every visual. Ctrl/⌘/Shift-click adds to the selection. The clicked visual keeps its other members visible but dimmed, the same way Power BI highlights a selection.
- **Filter chips** show every active filter and let you remove each one individually.
- **Time-intelligence KPIs:** each KPI card compares the selected period with the same-length period before it and includes a monthly sparkline.
- **Actual vs. target:** monthly targets are set per region, with an attainment gauge whose colour shows status (on target, slightly behind, behind).
- **Visual header menu** on every card, like Power BI:
  - *Show as table*
  - *Focus mode* (full screen)
  - *Export data* (CSV of that visual)
- **Indonesia choropleth map** with Revenue, Margin and Growth (diverging) views, plus zoom and pan.
- **Cohort retention heatmap**, a **discount vs. margin** bubble chart, a profit-by-sub-category diverging bar chart, and a top-products table.
- **Shareable state:** the page, period and filters are stored in the URL hash.
- **Light and dark theme**, responsive down to phone width.

| | |
|---|---|
| ![Products (dark)](docs/products-dark.png) | ![Regional](docs/regional.png) |

## Data model

Each row of `data/sales.csv` is one **order line** (26k rows, Jan 2023 – Dec 2025).

| Column | Description |
|---|---|
| `order_id`, `order_date` | Order key and date |
| `customer_id`, `segment` | Customer and segment (Consumer / SME / Corporate) |
| `channel` | Marketplace, Online Store, Retail Store, B2B Sales |
| `payment_method`, `ship_mode`, `delivery_days` | Fulfilment attributes |
| `region`, `province`, `city` | Geography (6 regions, 34 provinces) |
| `product_id`, `category`, `sub_category`, `product_name` | Product hierarchy |
| `quantity`, `unit_price`, `discount` | Line pricing |
| `sales`, `cost`, `profit` | Measures (IDR) |
| `returned` | 1 if the order was returned |

`data/targets.csv` holds the monthly revenue target per region (`month`, `region`, `target_sales`).

The dataset is produced by `scripts/build_dataset.py`. The script is reproducible (fixed seed, standard library only) and models realistic business patterns:

- year-over-year growth, with faster growth outside Java
- a channel shift towards digital
- the Ramadan / Lebaran peak and the post-Lebaran dip
- 9.9 / 10.10 / 11.11 / 12.12 campaign spikes
- payday effects and B2B bulk orders
- marketplace fees and returns

```bash
python scripts/build_dataset.py
```

### Key measures (DAX-style definitions)

```
Revenue          = SUM(sales)
Gross Profit     = SUM(profit)
Profit Margin    = [Gross Profit] / [Revenue]
Orders           = DISTINCTCOUNT(order_id)
AOV              = [Revenue] / [Orders]
Avg Discount     = 1 - [Revenue] / SUMX(quantity * unit_price)
Return Rate      = DISTINCTCOUNT(order_id WHERE returned = 1) / [Orders]
New Customers    = customers whose first-ever order falls in the selected period
Repeat Rate      = customers with ≥ 2 orders in period / active customers
Target Attain.   = [Revenue] / SUM(target_sales)      -- region grain only
Prior Period     = same measure over the same number of months immediately before
```

## Tech stack

- **Plain HTML, CSS and JavaScript (ES modules).** No build step and no framework.
- **[Apache ECharts](https://echarts.apache.org/)** for the charts and the map, and **[Papa Parse](https://www.papaparse.com/)** for CSV parsing. Both are vendored in `assets/vendor/`.
- **Python** (standard library only) for the data pipeline.
- The province boundaries come from public BAKOSURTANAL / Dukcapil boundary data (via [ans-4175/peta-indonesia-geojson](https://github.com/ans-4175/peta-indonesia-geojson)), simplified for the web.

```
├── index.html                 # report layout (pages, slicers, cards)
├── assets/
│   ├── css/style.css          # design tokens (light/dark), layout
│   ├── js/app.js              # state, filtering, cross-filter, all visuals
│   ├── js/util.js             # formatting, aggregation, theme tokens
│   ├── geo/                   # Indonesia province GeoJSON
│   └── vendor/                # echarts, papaparse
├── data/                      # sales.csv, targets.csv
├── scripts/build_dataset.py   # data pipeline
└── .github/workflows/pages.yml
```

## Run locally

The dashboard loads CSV files with `fetch`, so it has to be served over HTTP:

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Deployment

The repository includes a GitHub Actions workflow that publishes the site to GitHub Pages:

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main`. The workflow deploys the site to `https://haikalfr04.github.io/Sales-Dashboard/`.

---

### Ringkasan (Bahasa Indonesia)

Dashboard penjualan interaktif bergaya Power BI untuk perusahaan ritel omnichannel di Indonesia. Dashboard ini menampilkan:

- KPI dengan perbandingan terhadap periode sebelumnya
- realisasi vs. target per wilayah
- analisis produk, kohort retensi pelanggan
- peta penjualan per provinsi

Semua visual saling terhubung lewat **cross-filter**: klik satu elemen, dan seluruh dashboard ikut terfilter. Setiap visual juga punya tiga menu: tampilkan sebagai tabel, focus mode, dan ekspor CSV.

Untuk menjalankannya secara lokal: `python -m http.server`, lalu buka `http://localhost:8000`.
