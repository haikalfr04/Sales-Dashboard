import {
  fmt, monthLabel, monthLong, ymToIdx, idxToYm, ymRange, tokens, aggregate, totals, growth, esc, downloadCsv,
} from './util.js';

/* global echarts, Papa */

// ===========================================================================
// State
// ===========================================================================
const DIMS = {
  region: 'Region', province: 'Province', category: 'Category', sub_category: 'Sub-category',
  channel: 'Channel', segment: 'Segment', payment_method: 'Payment',
};
const SLICER_DIMS = ['region', 'category', 'channel', 'segment'];
const PAGES = {
  overview: ['Sales Overview', 'Revenue, profitability and target attainment'],
  products: ['Product Performance', 'Category mix, profitability and best sellers'],
  customers: ['Customer Insights', 'Acquisition, retention and purchasing behaviour'],
  regional: ['Regional Performance', 'Sales footprint across Indonesian provinces'],
  data: ['Transaction Explorer', 'Order-line detail for the current filter context'],
};
const PRESETS = {
  2023: ['2023-01', '2023-12'], 2024: ['2024-01', '2024-12'], 2025: ['2025-01', '2025-12'],
  'h2-2025': ['2025-07', '2025-12'], all: null,
};
// fixed entity -> categorical slot (colour follows the entity, never its rank)
const SLOT = {
  channel: { Marketplace: 0, 'Online Store': 1, 'Retail Store': 2, 'B2B Sales': 3 },
  category: { Electronics: 0, 'Home & Living': 1, Fashion: 2, 'Health & Beauty': 3, Groceries: 4, 'Office Supplies': 5 },
  ship: { 'Same Day': 0, Express: 1, Regular: 2 },
};

const state = {
  page: 'overview', from: '2025-01', to: '2025-12', grain: 'month', topMetric: 'sales', mapMetric: 'sales',
  f: Object.fromEntries(Object.keys(DIMS).map(k => [k, new Set()])),
  data: { q: '', sort: 'order_date', dir: -1, page: 0 },
};

let ROWS = [], TARGETS = new Map(), FIRST_ORDER = new Map(), MIN_I = 0, MAX_I = 0;
const viz = {};           // id -> { chart, option, table, title }
const altMode = new Set(); // cards showing their table view
let T = null;              // theme tokens

// ===========================================================================
// Data loading
// ===========================================================================
const parseCsv = url => new Promise((resolve, reject) =>
  Papa.parse(url, { download: true, header: true, dynamicTyping: true, skipEmptyLines: true, complete: r => resolve(r.data), error: reject }));

async function load() {
  const [sales, targets, geo] = await Promise.all([
    parseCsv('data/sales.csv'), parseCsv('data/targets.csv'), fetch('assets/geo/indonesia-provinces.json').then(r => r.json()),
  ]);
  echarts.registerMap('ID', geo);
  const day0 = Date.UTC(2000, 0, 1);
  ROWS = sales.map(r => {
    const ym = r.order_date.slice(0, 7);
    return { ...r, ym, mi: ymToIdx(ym), dn: Math.round((Date.parse(r.order_date) - day0) / 864e5) };
  });
  for (const t of targets) TARGETS.set(`${t.month}|${t.region}`, t.target_sales);
  MIN_I = Math.min(...ROWS.map(r => r.mi)); MAX_I = Math.max(...ROWS.map(r => r.mi));
  for (const r of ROWS) {
    const f = FIRST_ORDER.get(r.customer_id);
    if (f === undefined || r.mi < f) FIRST_ORDER.set(r.customer_id, r.mi);
  }
  const last = ROWS.reduce((m, r) => (r.order_date > m ? r.order_date : m), '');
  document.getElementById('dataStamp').textContent =
    `Data through ${new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${fmt.int(ROWS.length)} order lines`;
}

// ===========================================================================
// Filter context
// ===========================================================================
const period = () => ({ a: ymToIdx(state.from), b: ymToIdx(state.to) });
function prevPeriod() {
  const { a, b } = period(), n = b - a + 1;
  return { a: a - n, b: a - 1, ok: a - n >= MIN_I };
}
function matches(r, exclude) {
  for (const k in state.f) {
    if (k === exclude) continue;
    const s = state.f[k];
    if (s.size && !s.has(r[k])) return false;
  }
  return true;
}
let memo = new Map();
function rowsFor(which = 'cur', exclude = null) {
  const key = which + '|' + exclude;
  if (memo.has(key)) return memo.get(key);
  let out;
  if (which === 'all') out = ROWS.filter(r => matches(r, exclude));
  else {
    const p = which === 'cur' ? period() : prevPeriod();
    out = which === 'prev' && !p.ok ? [] : ROWS.filter(r => r.mi >= p.a && r.mi <= p.b && matches(r, exclude));
  }
  memo.set(key, out);
  return out;
}
const hasPrev = () => prevPeriod().ok;
const anyFilter = () => Object.values(state.f).some(s => s.size);
const dimmed = (dim, name) => state.f[dim].size > 0 && !state.f[dim].has(name);

function toggle(dim, value, additive = false) {
  const s = state.f[dim];
  if (additive) s.has(value) ? s.delete(value) : s.add(value);
  else if (s.size === 1 && s.has(value)) s.clear();
  else { s.clear(); s.add(value); }
  render();
}
const isAdditive = p => { const e = p?.event?.event; return !!(e && (e.ctrlKey || e.metaKey || e.shiftKey)); };

// ===========================================================================
// URL hash (shareable filter state)
// ===========================================================================
function writeHash() {
  const p = new URLSearchParams();
  p.set('p', state.page); p.set('from', state.from); p.set('to', state.to);
  for (const k in state.f) if (state.f[k].size) p.set(k, [...state.f[k]].join('|'));
  history.replaceState(null, '', '#' + p.toString());
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (PAGES[p.get('p')]) state.page = p.get('p');
  const re = /^\d{4}-\d{2}$/;
  if (re.test(p.get('from') || '')) state.from = p.get('from');
  if (re.test(p.get('to') || '')) state.to = p.get('to');
  for (const k in state.f) if (p.get(k)) state.f[k] = new Set(p.get(k).split('|'));
}

// ===========================================================================
// Chart plumbing
// ===========================================================================
function chartFor(id) {
  if (viz[id]?.chart) return viz[id].chart;
  const el = document.getElementById('c-' + id);
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  new ResizeObserver(() => chart.resize()).observe(el);
  viz[id] = { ...(viz[id] || {}), chart };
  return chart;
}
function setChart(id, option, table, onClick) {
  const chart = chartFor(id);
  chart.setOption(option, true);
  chart.off('click');
  if (onClick) chart.on('click', onClick);
  Object.assign(viz[id], { option, table });
  if (altMode.has(id)) renderAlt(id);
}
const baseOpt = () => ({
  textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: T.text2 },
  animationDuration: 450, animationDurationUpdate: 350,
  tooltip: {
    backgroundColor: T.surface, borderColor: T.borderStrong, borderWidth: 1, padding: [8, 10],
    textStyle: { color: T.text, fontSize: 12 }, confine: true,
    extraCssText: 'box-shadow:0 6px 20px rgba(0,0,0,.16);border-radius:8px;',
  },
});
const catAxis = (extra = {}) => ({
  axisLine: { lineStyle: { color: T.borderStrong } }, axisTick: { show: false },
  axisLabel: { color: T.text2, fontSize: 11 }, ...extra,
});
const valAxis = (extra = {}) => ({
  splitLine: { lineStyle: { color: T.grid } }, axisLine: { show: false }, axisTick: { show: false },
  axisLabel: { color: T.muted, fontSize: 11 }, ...extra,
});
const tint = (hex, t) => '#' + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + 255 * t).toString(16).padStart(2, '0')).join('');
const sw = c => `<span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${c};margin-right:6px"></span>`;
const tipRow = (label, value, color) =>
  `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7"><span style="color:${T.text2}">${color ? sw(color) : ''}${label}</span><b>${value}</b></div>`;
const tipHead = t => `<div style="font-weight:600;margin-bottom:4px">${esc(t)}</div>`;
const deltaTxt = (g, digits = 1) => g == null ? '—' :
  `<span style="color:${g >= 0 ? T.good : T.bad}">${g >= 0 ? '▲' : '▼'} ${fmt.signedPct(g, digits)}</span>`;

// ===========================================================================
// Slicers, chips, header
// ===========================================================================
const chevron = '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5z"/></svg>';
function buildSlicers() {
  for (const el of document.querySelectorAll('.slicer.dd')) {
    const dim = el.dataset.field;
    const totalsBy = aggregate(ROWS, r => r[dim]);
    const values = [...totalsBy.keys()].sort((a, b) => totalsBy.get(b).sales - totalsBy.get(a).sales);
    el.innerHTML = `<span class="dd-label">${DIMS[dim]}</span>
      <button class="dd-btn" aria-haspopup="listbox" aria-expanded="false"><span class="dd-text"></span>${chevron}</button>
      <div class="dd-menu" hidden>
        <label class="dd-all"><input type="checkbox" data-all> <span>Select all</span></label>
        ${values.map(v => `<label><input type="checkbox" value="${esc(v)}"> <span>${esc(v)}</span></label>`).join('')}
      </div>`;
    const btn = el.querySelector('.dd-btn'), menu = el.querySelector('.dd-menu');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = menu.hidden;
      document.querySelectorAll('.dd-menu').forEach(m => { m.hidden = true; m.previousElementSibling.setAttribute('aria-expanded', 'false'); });
      menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    });
    menu.addEventListener('click', e => e.stopPropagation());
    menu.addEventListener('change', e => {
      const s = state.f[dim];
      if (e.target.dataset.all !== undefined) s.clear();
      else e.target.checked ? s.add(e.target.value) : s.delete(e.target.value);
      render();
    });
  }
  document.addEventListener('click', () => document.querySelectorAll('.dd-menu').forEach(m => { m.hidden = true; }));
}
function syncSlicers() {
  for (const el of document.querySelectorAll('.slicer.dd')) {
    const s = state.f[el.dataset.field];
    el.querySelector('.dd-text').textContent = !s.size ? 'All' : s.size === 1 ? [...s][0] : `${s.size} selected`;
    el.querySelector('.dd-btn').classList.toggle('has', s.size > 0);
    el.querySelector('[data-all]').checked = !s.size;
    el.querySelectorAll('input[value]').forEach(i => { i.checked = s.has(i.value); });
  }
  document.getElementById('dateFrom').value = state.from;
  document.getElementById('dateTo').value = state.to;
  const preset = Object.entries(PRESETS).find(([, v]) =>
    v ? v[0] === state.from && v[1] === state.to : state.from === idxToYm(MIN_I) && state.to === idxToYm(MAX_I));
  document.querySelectorAll('#periodPresets button').forEach(b => b.classList.toggle('on', !!preset && b.dataset.preset === preset[0]));

  const chips = document.getElementById('chips');
  chips.innerHTML = Object.entries(state.f).flatMap(([k, s]) => [...s].map(v =>
    `<span class="chip"><b>${DIMS[k]}:</b> ${esc(v)}<button data-k="${k}" data-v="${esc(v)}" aria-label="Remove filter ${esc(v)}">
      <svg viewBox="0 0 24 24" width="12" height="12"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg></button></span>`)).join('');
}

function setPeriod(from, to) {
  const lo = idxToYm(MIN_I), hi = idxToYm(MAX_I);
  from = from < lo ? lo : from > hi ? hi : from;
  to = to < lo ? lo : to > hi ? hi : to;
  if (from > to) [from, to] = [to, from];
  state.from = from; state.to = to;
  render();
}

function bindControls() {
  document.querySelectorAll('.page-btn').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
  document.getElementById('periodPresets').addEventListener('click', e => {
    const p = e.target.dataset.preset; if (!p) return;
    const v = PRESETS[p] || [idxToYm(MIN_I), idxToYm(MAX_I)];
    setPeriod(v[0], v[1]);
  });
  const df = document.getElementById('dateFrom'), dt = document.getElementById('dateTo');
  df.min = dt.min = idxToYm(MIN_I); df.max = dt.max = idxToYm(MAX_I);
  df.addEventListener('change', () => df.value && setPeriod(df.value, state.to));
  dt.addEventListener('change', () => dt.value && setPeriod(state.from, dt.value));
  document.getElementById('chips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.f[b.dataset.k].delete(b.dataset.v); render();
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    for (const k in state.f) state.f[k].clear();
    state.from = '2025-01'; state.to = '2025-12'; render();
  });
  const seg = (id, key, attr) => document.getElementById(id).addEventListener('click', e => {
    const v = e.target.dataset[attr]; if (!v) return;
    state[key] = v;
    e.currentTarget.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset[attr] === v));
    renderPage();
  });
  seg('grain', 'grain', 'grain'); seg('topMetric', 'topMetric', 'm'); seg('mapMetric', 'mapMetric', 'm');

  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = tokens().dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('nr-theme', next); } catch (e) { /* storage unavailable */ }
    renderPage();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderPage());

  // data page
  const q = document.getElementById('dataSearch');
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.data.q = q.value.trim().toLowerCase(); state.data.page = 0; renderData(); }, 180); });
  document.getElementById('exportBtn').addEventListener('click', () =>
    downloadCsv(`nusantara-sales_${state.from}_${state.to}.csv`, DATA_COLS, dataRows()));
  document.getElementById('focusClose').addEventListener('click', closeFocus);
  document.getElementById('focus').addEventListener('click', e => { if (e.target.id === 'focus') closeFocus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFocus(); });
}

function showPage(p) {
  state.page = p;
  document.querySelectorAll('.page-btn').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  document.querySelectorAll('.page').forEach(s => s.classList.toggle('active', s.id === 'page-' + p));
  document.getElementById('pageTitle').textContent = PAGES[p][0];
  document.getElementById('pageSub').textContent = PAGES[p][1];
  writeHash();
  renderPage();
}

// ===========================================================================
// Card menus: table view, focus mode, export
// ===========================================================================
const ICONS = {
  table: '<svg viewBox="0 0 24 24"><path d="M3 4h18v16H3zm2 2v3h14V6zm0 5v3h6v-3zm8 0v3h6v-3zm-8 5v2h6v-2zm8 0v2h6v-2z"/></svg>',
  focus: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M12 16 7 11l1.4-1.4 2.6 2.6V4h2v8.2l2.6-2.6L17 11zm-7 4v-2h14v2z"/></svg>',
};
function buildCardMenus() {
  for (const card of document.querySelectorAll('.card[data-viz]')) {
    const id = card.dataset.viz, hasChart = !!card.querySelector('.chart');
    viz[id] = { ...(viz[id] || {}), title: card.querySelector('h3').textContent };
    const menu = document.createElement('div');
    menu.className = 'card-menu';
    menu.innerHTML = (hasChart ? `<button data-a="table" title="Show as table" aria-label="Show as table">${ICONS.table}</button>` : '') +
      `<button data-a="focus" title="Focus mode" aria-label="Focus mode">${ICONS.focus}</button>
       <button data-a="export" title="Export data (CSV)" aria-label="Export data">${ICONS.export}</button>`;
    let tools = card.querySelector('.card-tools');
    if (!tools) { tools = document.createElement('div'); tools.className = 'card-tools'; card.querySelector('header').appendChild(tools); }
    tools.appendChild(menu);
    if (hasChart) {
      const alt = document.createElement('div');
      alt.className = 'alt-table table-wrap'; alt.hidden = true; alt.id = 'alt-' + id;
      card.appendChild(alt);
    }
    menu.addEventListener('click', e => {
      const a = e.target.closest('button')?.dataset.a; if (!a) return;
      if (a === 'table') {
        altMode.has(id) ? altMode.delete(id) : altMode.add(id);
        e.target.closest('button').classList.toggle('on', altMode.has(id));
        card.querySelector('.chart').hidden = altMode.has(id);
        document.getElementById('alt-' + id).hidden = !altMode.has(id);
        if (altMode.has(id)) renderAlt(id); else viz[id].chart?.resize();
      } else if (a === 'focus') openFocus(id, card);
      else if (a === 'export') {
        const t = viz[id].table; if (!t) return;
        downloadCsv(`${id}_${state.from}_${state.to}.csv`, t.cols.map(c => ({ label: c.label, raw: r => r[c.key] })), t.rows);
      }
    });
  }
}
function tableHtml(t) {
  if (!t || !t.rows.length) return '<div class="empty">No data for the current selection</div>';
  return `<table><thead><tr>${t.cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map(r => `<tr>${t.cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r[c.key]) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderAlt(id) { const el = document.getElementById('alt-' + id); if (el) el.innerHTML = tableHtml(viz[id].table); }

let focusChart = null;
function openFocus(id, card) {
  const body = document.getElementById('focusBody');
  document.getElementById('focusTitle').textContent = viz[id].title;
  document.getElementById('focus').hidden = false;
  if (viz[id].option && !altMode.has(id)) {
    body.innerHTML = '<div class="chart"></div>';
    focusChart = echarts.init(body.firstChild);
    focusChart.setOption(viz[id].option);
  } else {
    body.innerHTML = card.querySelector('.table-wrap').innerHTML;
  }
}
function closeFocus() {
  document.getElementById('focus').hidden = true;
  focusChart?.dispose(); focusChart = null;
  document.getElementById('focusBody').innerHTML = '';
}

// ===========================================================================
// KPI cards
// ===========================================================================
const arrow = up => `<svg viewBox="0 0 24 24"><path d="${up ? 'M12 5l7 8h-5v6h-4v-6H5z' : 'M12 19l-7-8h5V5h4v6h5z'}"/></svg>`;
function spark(values, color) {
  if (values.length < 2) return '';
  const w = 200, h = 34, min = Math.min(...values), max = Math.max(...values), rg = max - min || 1;
  const pts = values.map((v, i) => [i / (values.length - 1) * w, h - 3 - (v - min) / rg * (h - 6)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
  return `<svg class="k-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="34">
    <path d="${d}L${w},${h}L0,${h}Z" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}
/**
 * kpi: { label, value, display, prev, mode: 'pct'|'pp', invert, sparkline }
 */
function renderKpis(elId, list) {
  const el = document.getElementById(elId);
  el.classList.toggle('k4', list.length === 4);
  el.innerHTML = list.map(k => {
    let delta = '<span class="k-delta flat">—</span><span class="k-cmp">no prior period</span>';
    if (k.prev != null && isFinite(k.prev) && (k.mode === 'pp' || k.prev !== 0)) {
      const d = k.mode === 'pp' ? k.value - k.prev : k.value / k.prev - 1;
      const good = k.invert ? d < 0 : d > 0;
      const cls = Math.abs(d) < 0.0005 ? 'flat' : good ? 'up' : 'down';
      delta = `<span class="k-delta ${cls}">${cls === 'flat' ? '±0.0' + (k.mode === 'pp' ? ' pp' : '%') : arrow(d > 0) + (k.mode === 'pp' ? fmt.pp(d) : fmt.signedPct(d))}</span><span class="k-cmp">vs ${k.prevDisplay}</span>`;
    }
    return `<div class="kpi"><div class="k-label">${k.label}</div><div class="k-value">${k.display}</div>
      <div>${delta}</div>${spark(k.sparkline || [], T.series[0])}</div>`;
  }).join('');
}
function monthlySeries(rows, fn) {
  const months = ymRange(state.from, state.to), by = new Map(months.map(m => [m, []]));
  for (const r of rows) by.get(r.ym)?.push(r);
  return months.map(m => fn(by.get(m)));
}

// ===========================================================================
// Reusable ranked bar (cross-filtering)
// ===========================================================================
function rankBar(id, dim, { limit = 0, horizontal = true, unit = 'sales' } = {}) {
  const cur = aggregate(rowsFor('cur', dim), r => r[dim]);
  const prev = aggregate(rowsFor('prev', dim), r => r[dim]);
  const total = [...cur.values()].reduce((s, a) => s + a.sales, 0);
  let items = [...cur.entries()].map(([name, a]) => ({
    name, sales: a.sales, profit: a.profit, margin: a.sales ? a.profit / a.sales : 0,
    share: total ? a.sales / total : 0, orders: a.orders.size,
    growth: growth(a.sales, prev.get(name)?.sales),
  })).sort((a, b) => b.sales - a.sales);
  if (limit) items = items.slice(0, limit);
  const ordered = horizontal ? [...items].reverse() : items;
  const option = {
    ...baseOpt(),
    grid: { left: 12, right: 64, top: 6, bottom: 4, containLabel: true },
    [horizontal ? 'yAxis' : 'xAxis']: { type: 'category', data: ordered.map(i => i.name), ...catAxis(), axisLabel: { color: T.text2, fontSize: 11 } },
    [horizontal ? 'xAxis' : 'yAxis']: { type: 'value', ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: fmt.idrAxis } }), ...(horizontal ? { splitNumber: 3 } : {}) },
    tooltip: {
      ...baseOpt().tooltip, trigger: 'item',
      formatter: p => { const i = ordered[p.dataIndex]; return tipHead(i.name) + tipRow('Revenue', fmt.idr(i.sales, 2)) + tipRow('Share', fmt.pct(i.share)) +
        tipRow('Profit margin', fmt.pct(i.margin)) + tipRow('vs prior period', deltaTxt(i.growth)) + `<div style="color:${T.muted};font-size:11px;margin-top:4px">Click to filter · Ctrl+click to add</div>`; },
    },
    series: [{
      type: 'bar', barMaxWidth: 22, barCategoryGap: '28%',
      data: ordered.map(i => ({ value: i.sales, itemStyle: { color: T.series[0], opacity: dimmed(dim, i.name) ? 0.25 : 1, borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] } })),
      label: { show: true, position: horizontal ? 'right' : 'top', color: T.text2, fontSize: 11, formatter: p => fmt.idr(p.value) },
      emphasis: { itemStyle: { color: T.series[0], opacity: 1 } }, cursor: 'pointer',
    }],
  };
  const table = {
    cols: [{ label: DIMS[dim], key: 'name' }, { label: 'Revenue', key: 'sales', num: 1, fmt: v => fmt.idrFull(v) },
      { label: 'Share', key: 'share', num: 1, fmt: v => fmt.pct(v) }, { label: 'Margin', key: 'margin', num: 1, fmt: v => fmt.pct(v) },
      { label: 'Orders', key: 'orders', num: 1, fmt: fmt.int }, { label: 'vs prior', key: 'growth', num: 1, fmt: v => v == null ? '—' : fmt.signedPct(v) }],
    rows: items,
  };
  setChart(id, option, table, p => toggle(dim, ordered[p.dataIndex].name, isAdditive(p)));
}

// ===========================================================================
// PAGE: Overview
// ===========================================================================
function renderOverview() {
  const cur = rowsFor('cur'), prev = rowsFor('prev');
  const c = totals(cur), p = hasPrev() ? totals(prev) : null;
  renderKpis('kpis', [
    { label: 'Revenue', value: c.sales, display: fmt.idr(c.sales, 2), prev: p?.sales, prevDisplay: p && fmt.idr(p.sales), sparkline: monthlySeries(cur, rs => rs.reduce((s, r) => s + r.sales, 0)) },
    { label: 'Gross profit', value: c.profit, display: fmt.idr(c.profit, 2), prev: p?.profit, prevDisplay: p && fmt.idr(p.profit), sparkline: monthlySeries(cur, rs => rs.reduce((s, r) => s + r.profit, 0)) },
    { label: 'Profit margin', value: c.margin, display: fmt.pct(c.margin), prev: p?.margin, prevDisplay: p && fmt.pct(p.margin), mode: 'pp', sparkline: monthlySeries(cur, rs => totals(rs).margin) },
    { label: 'Orders', value: c.orders.size, display: fmt.int(c.orders.size), prev: p?.orders.size, prevDisplay: p && fmt.int(p.orders.size), sparkline: monthlySeries(cur, rs => new Set(rs.map(r => r.order_id)).size) },
    { label: 'Avg. order value', value: c.aov, display: fmt.idr(c.aov, 2), prev: p?.aov, prevDisplay: p && fmt.idr(p.aov), sparkline: monthlySeries(cur, rs => totals(rs).aov) },
    { label: 'Active customers', value: c.customers.size, display: fmt.int(c.customers.size), prev: p?.customers.size, prevDisplay: p && fmt.int(p.customers.size), sparkline: monthlySeries(cur, rs => new Set(rs.map(r => r.customer_id)).size) },
  ]);
  renderTrend(cur, prev);
  renderTarget(cur);
  renderChannel();
  rankBar('category', 'category');
  rankBar('region', 'region');
}

function bucketer(fromYm) {
  const fromI = ymToIdx(fromYm);
  const d0 = Math.round((Date.UTC(+fromYm.slice(0, 4), +fromYm.slice(5, 7) - 1, 1) - Date.UTC(2000, 0, 1)) / 864e5);
  if (state.grain === 'week') return r => Math.floor((r.dn - d0) / 7);
  if (state.grain === 'quarter') return r => Math.floor((r.mi - fromI) / 3);
  return r => r.mi - fromI;
}
function bucketLabels(n) {
  const fromI = ymToIdx(state.from);
  if (state.grain === 'month') return Array.from({ length: n }, (_, i) => monthLabel(idxToYm(fromI + i)));
  if (state.grain === 'quarter') return Array.from({ length: n }, (_, i) => { const ym = idxToYm(fromI + i * 3); return `Q${Math.floor((+ym.slice(5) - 1) / 3) + 1} ${ym.slice(2, 4)}`; });
  const start = Date.UTC(+state.from.slice(0, 4), +state.from.slice(5, 7) - 1, 1);
  return Array.from({ length: n }, (_, i) => new Date(start + i * 7 * 864e5).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
}
function renderTrend(cur, prev) {
  const { a, b } = period(), pp = prevPeriod();
  const months = b - a + 1;
  const n = state.grain === 'month' ? months : state.grain === 'quarter' ? Math.ceil(months / 3)
    : Math.ceil((Date.UTC(+state.to.slice(0, 4), +state.to.slice(5, 7), 1) - Date.UTC(+state.from.slice(0, 4), +state.from.slice(5, 7) - 1, 1)) / 864e5 / 7);
  const bc = bucketer(state.from), bp = bucketer(idxToYm(pp.a));
  const cv = new Array(n).fill(0), pv = new Array(n).fill(0);
  for (const r of cur) { const i = bc(r); if (i >= 0 && i < n) cv[i] += r.sales; }
  if (pp.ok) for (const r of prev) { const i = bp(r); if (i >= 0 && i < n) pv[i] += r.sales; }
  const labels = bucketLabels(n);
  const peak = cv.indexOf(Math.max(...cv));
  const option = {
    ...baseOpt(),
    grid: { left: 8, right: 28, top: 34, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: T.text2, fontSize: 12 },
      data: pp.ok ? ['Current period', 'Prior period'] : ['Current period'] },
    xAxis: { type: 'category', data: labels, boundaryGap: false, ...catAxis() },
    yAxis: { type: 'value', ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: fmt.idrAxis } }) },
    tooltip: {
      ...baseOpt().tooltip, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: T.borderStrong } },
      formatter: ps => { const i = ps[0].dataIndex;
        return tipHead(labels[i]) + tipRow('Current', fmt.idr(cv[i], 2), T.series[0]) +
          (pp.ok ? tipRow('Prior', fmt.idr(pv[i], 2), T.prev) + tipRow('Change', deltaTxt(growth(cv[i], pv[i]))) : ''); },
    },
    series: [
      { name: 'Current period', type: 'line', data: cv, smooth: 0.25, symbol: 'circle', symbolSize: 7, showSymbol: n <= 24,
        lineStyle: { width: 2, color: T.series[0] }, itemStyle: { color: T.series[0], borderColor: T.surface, borderWidth: 2 },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: T.series[0] + '40' }, { offset: 1, color: T.series[0] + '00' }]) },
        markPoint: n > 2 ? { symbol: 'circle', symbolSize: 0, label: { show: true, position: 'top', color: T.text, fontSize: 11, fontWeight: 600, formatter: () => 'Peak ' + fmt.idr(cv[peak]) },
          data: [{ coord: [peak, cv[peak]], label: { align: peak > n * 0.75 ? 'right' : peak < n * 0.15 ? 'left' : 'center' } }] } : undefined },
      ...(pp.ok ? [{ name: 'Prior period', type: 'line', data: pv, smooth: 0.25, symbol: 'none',
        lineStyle: { width: 2, type: [5, 4], color: T.prev }, itemStyle: { color: T.prev }, z: 1 }] : []),
    ],
  };
  const table = { cols: [{ label: 'Period', key: 'l' }, { label: 'Revenue', key: 'c', num: 1, fmt: fmt.idrFull },
    { label: 'Prior period', key: 'p', num: 1, fmt: v => pp.ok ? fmt.idrFull(v) : '—' }, { label: 'Change', key: 'g', num: 1, fmt: v => v == null ? '—' : fmt.signedPct(v) }],
    rows: labels.map((l, i) => ({ l, c: cv[i], p: pv[i], g: pp.ok ? growth(cv[i], pv[i]) : null })) };
  setChart('trend', option, table);
}

function renderTarget(cur) {
  const months = ymRange(state.from, state.to);
  const comparable = Object.entries(state.f).every(([k, s]) => k === 'region' || !s.size);
  const regions = state.f.region.size ? [...state.f.region] : [...new Set(ROWS.map(r => r.region))];
  const actual = monthlySeries(cur, rs => rs.reduce((s, r) => s + r.sales, 0));
  const target = months.map(m => regions.reduce((s, reg) => s + (TARGETS.get(`${m}|${reg}`) || 0), 0));
  document.getElementById('targetSub').textContent = comparable
    ? `Monthly revenue against plan${state.f.region.size ? ' · ' + [...state.f.region].join(', ') : ''}`
    : 'Targets are planned by region — clear product, channel and segment filters to compare';
  const att = actual.map((v, i) => target[i] ? v / target[i] : null);
  const statusColor = a => a == null ? T.series[0] : a >= 1 ? T.good : a >= 0.95 ? T.warn : T.bad;
  const option = {
    ...baseOpt(),
    grid: { left: 8, right: 16, top: 34, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 8, textStyle: { color: T.text2, fontSize: 12 }, data: comparable ? ['Actual', 'Target'] : ['Actual'] },
    xAxis: { type: 'category', data: months.map(monthLabel), ...catAxis() },
    yAxis: { type: 'value', ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: fmt.idrAxis } }) },
    tooltip: { ...baseOpt().tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: T.grid, opacity: 0.5 } },
      formatter: ps => { const i = ps[0].dataIndex;
        return tipHead(monthLong(months[i])) + tipRow('Actual', fmt.idr(actual[i], 2), T.series[0]) +
          (comparable ? tipRow('Target', fmt.idr(target[i], 2), T.text2) +
            tipRow('Attainment', `<span style="color:${statusColor(att[i])}">${att[i] >= 1 ? '✓' : '✕'} ${fmt.pct(att[i])}</span>`) : ''); } },
    series: [
      { name: 'Actual', type: 'bar', barMaxWidth: 26, data: actual.map(v => ({ value: v, itemStyle: { color: T.series[0], borderRadius: [4, 4, 0, 0] } })) },
      ...(comparable ? [{ name: 'Target', type: 'line', data: target, symbol: 'rect', symbolSize: [16, 3], step: false,
        lineStyle: { width: 0 }, itemStyle: { color: T.text }, z: 3 }] : []),
    ],
  };
  const table = { cols: [{ label: 'Month', key: 'm', fmt: monthLong }, { label: 'Actual', key: 'a', num: 1, fmt: fmt.idrFull },
    { label: 'Target', key: 't', num: 1, fmt: v => comparable ? fmt.idrFull(v) : '—' }, { label: 'Attainment', key: 'x', num: 1, fmt: v => comparable && v != null ? fmt.pct(v) : '—' }],
    rows: months.map((m, i) => ({ m, a: actual[i], t: target[i], x: att[i] })) };
  setChart('target', option, table);

  // attainment gauge
  const sa = actual.reduce((s, v) => s + v, 0), st = target.reduce((s, v) => s + v, 0);
  const pct = comparable && st ? sa / st : null;
  const col = statusColor(pct);
  const label = pct == null ? 'n/a' : pct >= 1 ? 'On target' : pct >= 0.95 ? 'Slightly behind' : 'Behind target';
  const gauge = {
    ...baseOpt(), tooltip: { show: false },
    series: [{
      type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: 120, radius: '92%', center: ['50%', '56%'],
      progress: { show: true, width: 16, roundCap: true, itemStyle: { color: col } },
      axisLine: { roundCap: true, lineStyle: { width: 16, color: [[1, T.surface2]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { show: false },
      anchor: { show: false },
      title: { show: true, offsetCenter: [0, '30%'], color: col, fontSize: 13, fontWeight: 600 },
      detail: { valueAnimation: true, offsetCenter: [0, '-2%'], fontSize: 34, fontWeight: 600, color: T.text,
        formatter: v => pct == null ? '—' : v.toFixed(1) + '%' },
      data: [{ value: pct == null ? 0 : +(pct * 100).toFixed(1), name: (pct == null ? '' : (pct >= 1 ? '✓ ' : '! ')) + label }],
    }],
    graphic: comparable ? [{ type: 'text', left: 'center', bottom: 8, style: { text: `${fmt.idr(sa)} of ${fmt.idr(st)} target`, fill: T.text2, font: '12px Inter, sans-serif' } },
      { type: 'text', left: 'center', bottom: 26, style: { text: `Gap ${sa - st >= 0 ? '+' : ''}${fmt.idr(sa - st)}`, fill: T.muted, font: '12px Inter, sans-serif' } }] : [],
  };
  setChart('attain', gauge, { cols: [{ label: 'Actual', key: 'a', num: 1, fmt: fmt.idrFull }, { label: 'Target', key: 't', num: 1, fmt: fmt.idrFull }, { label: 'Attainment', key: 'p', num: 1, fmt: v => v == null ? '—' : fmt.pct(v) }],
    rows: [{ a: sa, t: comparable ? st : null, p: pct }] });
}

function renderChannel() {
  const cur = aggregate(rowsFor('cur', 'channel'), r => r.channel);
  const prev = aggregate(rowsFor('prev', 'channel'), r => r.channel);
  const total = [...cur.values()].reduce((s, a) => s + a.sales, 0);
  const items = Object.keys(SLOT.channel).filter(k => cur.has(k)).map(name => {
    const a = cur.get(name);
    return { name, sales: a.sales, share: a.sales / total, margin: a.profit / a.sales, orders: a.orders.size, growth: growth(a.sales, prev.get(name)?.sales) };
  });
  const option = {
    ...baseOpt(),
    legend: { bottom: 0, left: 'center', icon: 'circle', itemWidth: 9, itemHeight: 9, textStyle: { color: T.text2, fontSize: 12 } },
    tooltip: { ...baseOpt().tooltip, trigger: 'item', formatter: p => { const i = items[p.dataIndex];
      return tipHead(i.name) + tipRow('Revenue', fmt.idr(i.sales, 2), p.color) + tipRow('Share', fmt.pct(i.share)) + tipRow('Margin', fmt.pct(i.margin)) + tipRow('vs prior period', deltaTxt(i.growth)); } },
    series: [{
      type: 'pie', radius: ['52%', '76%'], center: ['50%', '45%'], padAngle: 1.5,
      itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 4 },
      label: { show: true, position: 'outside', formatter: p => fmt.pct(items[p.dataIndex].share, 0), color: T.text2, fontSize: 11 },
      labelLine: { length: 6, length2: 6, lineStyle: { color: T.borderStrong } },
      data: items.map(i => ({ name: i.name, value: i.sales, itemStyle: { color: T.series[SLOT.channel[i.name]], opacity: dimmed('channel', i.name) ? 0.25 : 1 } })),
    }],
    graphic: [{ type: 'text', left: 'center', top: '38%', style: { text: fmt.idr(total), fill: T.text, font: '600 18px Inter, sans-serif', align: 'center' } },
      { type: 'text', left: 'center', top: '49%', style: { text: 'total revenue', fill: T.muted, font: '11px Inter, sans-serif', align: 'center' } }],
  };
  setChart('channel', option, {
    cols: [{ label: 'Channel', key: 'name' }, { label: 'Revenue', key: 'sales', num: 1, fmt: fmt.idrFull }, { label: 'Share', key: 'share', num: 1, fmt: v => fmt.pct(v) },
      { label: 'Margin', key: 'margin', num: 1, fmt: v => fmt.pct(v) }, { label: 'vs prior', key: 'growth', num: 1, fmt: v => v == null ? '—' : fmt.signedPct(v) }], rows: items,
  }, p => toggle('channel', p.name, isAdditive(p)));
}

// ===========================================================================
// PAGE: Products
// ===========================================================================
function renderProducts() {
  const cur = rowsFor('cur'), prev = rowsFor('prev');
  const c = totals(cur), p = hasPrev() ? totals(prev) : null;
  renderKpis('kpis-products', [
    { label: 'Units sold', value: c.qty, display: fmt.int(c.qty), prev: p?.qty, prevDisplay: p && fmt.int(p.qty), sparkline: monthlySeries(cur, rs => rs.reduce((s, r) => s + r.quantity, 0)) },
    { label: 'Gross margin', value: c.margin, display: fmt.pct(c.margin), prev: p?.margin, prevDisplay: p && fmt.pct(p.margin), mode: 'pp', sparkline: monthlySeries(cur, rs => totals(rs).margin) },
    { label: 'Avg. discount', value: c.discount, display: fmt.pct(c.discount), prev: p?.discount, prevDisplay: p && fmt.pct(p.discount), mode: 'pp', invert: true, sparkline: monthlySeries(cur, rs => totals(rs).discount) },
    { label: 'Return rate', value: c.returnRate, display: fmt.pct(c.returnRate), prev: p?.returnRate, prevDisplay: p && fmt.pct(p.returnRate), mode: 'pp', invert: true, sparkline: monthlySeries(cur, rs => totals(rs).returnRate) },
  ]);
  renderTreemap(); renderSubProfit(); renderTopProducts(); renderDiscount();
}

function renderTreemap() {
  // the treemap owns both category levels, so it ignores its own two filters and dims instead
  const { a, b } = period();
  const rs = ROWS.filter(r => r.mi >= a && r.mi <= b && Object.entries(state.f).every(([k, s]) =>
    k === 'category' || k === 'sub_category' || !s.size || s.has(r[k])));
  const byCat = aggregate(rs, r => r.category), bySub = aggregate(rs, r => r.category + '|' + r.sub_category);
  const total = [...byCat.values()].reduce((s, a) => s + a.sales, 0);
  const data = Object.keys(SLOT.category).filter(k => byCat.has(k)).map(cat => {
    const col = T.series[SLOT.category[cat]];
    const catDim = dimmed('category', cat);
    return {
      name: cat, value: byCat.get(cat).sales, itemStyle: { color: col, borderColor: col, opacity: catDim ? 0.3 : 1 },
      children: [...bySub.entries()].filter(([k]) => k.startsWith(cat + '|')).map(([k, a]) => {
        const sub = k.split('|')[1];
        return { name: sub, value: a.sales, margin: a.profit / a.sales,
          itemStyle: { color: tint(col, 0.42), opacity: (catDim || dimmed('sub_category', sub)) ? 0.25 : 1 } };
      }),
    };
  });
  const option = {
    ...baseOpt(),
    tooltip: { ...baseOpt().tooltip, formatter: p => {
      const path = p.treePathInfo.slice(1).map(x => x.name).join(' › ');
      return tipHead(path) + tipRow('Revenue', fmt.idr(p.value, 2)) + tipRow('Share of total', fmt.pct(p.value / total)) +
        (p.data.margin != null ? tipRow('Margin', fmt.pct(p.data.margin)) : '') + `<div style="color:${T.muted};font-size:11px;margin-top:4px">Click to filter</div>`; } },
    series: [{
      type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
      squareRatio: 1.2,
      upperLabel: { show: true, height: 24, color: '#0b0b0b', fontWeight: 600, fontSize: 12, padding: [0, 6], formatter: p => `${p.name}  ${fmt.idr(p.value)}` },
      label: { show: true, color: '#0b0b0b', fontSize: 11, lineHeight: 15, formatter: p => `${p.name}\n{v|${fmt.idr(p.value)}}`, rich: { v: { color: 'rgba(11,11,11,.72)', fontSize: 11 } } },
      levels: [
        { itemStyle: { borderColor: T.surface, borderWidth: 0, gapWidth: 3 }, upperLabel: { show: false } },
        { itemStyle: { borderWidth: 3, gapWidth: 2, borderColor: T.surface }, upperLabel: { show: true } },
        { itemStyle: { borderColor: T.surface, borderWidth: 0, gapWidth: 2, borderRadius: 3 } },
      ],
      data,
    }],
  };
  const tableRows = [...bySub.entries()].map(([k, a]) => ({ cat: k.split('|')[0], sub: k.split('|')[1], sales: a.sales, share: a.sales / total, margin: a.profit / a.sales }))
    .sort((a, b) => b.sales - a.sales);
  setChart('treemap', option, { cols: [{ label: 'Category', key: 'cat' }, { label: 'Sub-category', key: 'sub' }, { label: 'Revenue', key: 'sales', num: 1, fmt: fmt.idrFull },
    { label: 'Share', key: 'share', num: 1, fmt: v => fmt.pct(v) }, { label: 'Margin', key: 'margin', num: 1, fmt: v => fmt.pct(v) }], rows: tableRows },
  p => { const depth = p.treePathInfo.length; if (depth === 2) toggle('category', p.name, isAdditive(p)); else if (depth === 3) toggle('sub_category', p.name, isAdditive(p)); });
}

function renderSubProfit() {
  const cur = aggregate(rowsFor('cur', 'sub_category'), r => r.sub_category);
  const items = [...cur.entries()].map(([name, a]) => ({ name, profit: a.profit, sales: a.sales, margin: a.profit / a.sales })).sort((a, b) => a.profit - b.profit);
  const option = {
    ...baseOpt(),
    grid: { left: 8, right: 60, top: 4, bottom: 4, containLabel: true },
    yAxis: { type: 'category', data: items.map(i => i.name), ...catAxis(), axisLabel: { color: T.text2, fontSize: 11 } },
    xAxis: { type: 'value', splitNumber: 3, ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: fmt.idrAxis } }) },
    tooltip: { ...baseOpt().tooltip, trigger: 'item', formatter: p => { const i = items[p.dataIndex];
      return tipHead(i.name) + tipRow('Profit', `<span style="color:${i.profit < 0 ? T.bad : T.text}">${fmt.idr(i.profit, 2)}</span>`) + tipRow('Revenue', fmt.idr(i.sales, 2)) + tipRow('Margin', fmt.pct(i.margin)); } },
    series: [{ type: 'bar', barMaxWidth: 14, barCategoryGap: '30%', cursor: 'pointer',
      data: items.map(i => ({ value: i.profit, itemStyle: { color: i.profit < 0 ? T.divNeg : T.divPos, opacity: dimmed('sub_category', i.name) ? 0.25 : 1, borderRadius: i.profit < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', fontSize: 10, color: T.text2, formatter: p => fmt.idr(p.value) },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: T.borderStrong, type: 'solid' }, label: { show: false }, data: [{ xAxis: 0 }] } }],
  };
  setChart('subprofit', option, { cols: [{ label: 'Sub-category', key: 'name' }, { label: 'Profit', key: 'profit', num: 1, fmt: fmt.idrFull },
    { label: 'Revenue', key: 'sales', num: 1, fmt: fmt.idrFull }, { label: 'Margin', key: 'margin', num: 1, fmt: v => fmt.pct(v) }], rows: [...items].reverse() },
  p => toggle('sub_category', items[p.dataIndex].name, isAdditive(p)));
}

function renderTopProducts() {
  const m = state.topMetric;
  const cur = aggregate(rowsFor('cur'), r => r.product_name), prev = aggregate(rowsFor('prev'), r => r.product_name);
  const meta = new Map(ROWS.map(r => [r.product_name, r]));
  const val = a => m === 'quantity' ? a.qty : a[m];
  const items = [...cur.entries()].map(([name, a]) => ({
    name, sub: meta.get(name).sub_category, cat: meta.get(name).category, sales: a.sales, profit: a.profit, quantity: a.qty,
    margin: a.profit / a.sales, growth: prev.has(name) ? growth(val(a), val(prev.get(name))) : null,
  })).sort((a, b) => b[m] - a[m]).slice(0, 10);
  const max = Math.max(...items.map(i => Math.abs(i[m])), 1);
  const show = v => m === 'quantity' ? fmt.int(v) : fmt.idr(v, 2);
  const label = { sales: 'Revenue', profit: 'Profit', quantity: 'Units' }[m];
  document.getElementById('t-top').innerHTML = !items.length ? '<div class="empty">No data for the current selection</div>' :
    `<table><thead><tr><th>#</th><th>Product</th><th class="num">${label}</th><th class="num">Margin</th><th class="num">vs prior</th></tr></thead><tbody>
    ${items.map((i, k) => `<tr><td class="rank">${k + 1}</td>
      <td><div>${esc(i.name)}</div><div class="sub">${sw(T.series[SLOT.category[i.cat]])}${esc(i.cat)} · ${esc(i.sub)}</div></td>
      <td class="num"><div class="bar-cell"><span>${show(i[m])}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${Math.max(0, i[m]) / max * 100}%"></span></span></div></td>
      <td class="num">${fmt.pct(i.margin)}</td>
      <td class="num">${i.growth == null ? '—' : `<span class="pill ${i.growth >= 0 ? 'up' : 'down'}">${fmt.signedPct(i.growth)}</span>`}</td></tr>`).join('')}</tbody></table>`;
  viz.topProducts.table = { cols: [{ label: 'Product', key: 'name' }, { label: 'Category', key: 'cat' }, { label: 'Sub-category', key: 'sub' },
    { label: 'Revenue', key: 'sales' }, { label: 'Profit', key: 'profit' }, { label: 'Units', key: 'quantity' }, { label: 'Margin', key: 'margin' }, { label: 'vs prior', key: 'growth' }], rows: items };
}

function renderDiscount() {
  const rs = rowsFor('cur');
  const by = aggregate(rs, r => r.sub_category);
  const items = [...by.entries()].map(([name, a]) => ({ name, disc: 1 - a.sales / a.gross, margin: a.profit / a.sales, sales: a.sales }));
  const maxS = Math.max(...items.map(i => i.sales), 1);
  const option = {
    ...baseOpt(),
    grid: { left: 8, right: 72, top: 16, bottom: 28, containLabel: true },
    xAxis: { type: 'value', name: 'Avg. discount', nameLocation: 'middle', nameGap: 26, nameTextStyle: { color: T.muted, fontSize: 11 },
      ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: v => (v * 100).toFixed(0) + '%' } }), scale: true },
    yAxis: { type: 'value', name: 'Profit margin', nameTextStyle: { color: T.muted, fontSize: 11, align: 'left' },
      ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: v => (v * 100).toFixed(0) + '%' } }) },
    tooltip: { ...baseOpt().tooltip, trigger: 'item', formatter: p => { const i = items[p.dataIndex];
      return tipHead(i.name) + tipRow('Avg. discount', fmt.pct(i.disc)) + tipRow('Margin', fmt.pct(i.margin)) + tipRow('Revenue', fmt.idr(i.sales, 2)); } },
    series: [{ type: 'scatter', cursor: 'pointer',
      data: items.map(i => ({ value: [i.disc, i.margin], symbolSize: 10 + Math.sqrt(i.sales / maxS) * 34,
        itemStyle: { color: i.margin < 0 ? T.divNeg : T.series[0], opacity: dimmed('sub_category', i.name) ? 0.2 : 0.72, borderColor: T.surface, borderWidth: 2 } })),
      label: { show: true, position: 'right', formatter: p => items[p.dataIndex].name, color: T.text2, fontSize: 10 },
      labelLayout: { hideOverlap: true },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: T.borderStrong, type: [4, 4] }, label: { show: false }, data: [{ yAxis: 0 }] } }],
  };
  setChart('discount', option, { cols: [{ label: 'Sub-category', key: 'name' }, { label: 'Avg. discount', key: 'disc', num: 1, fmt: v => fmt.pct(v) },
    { label: 'Margin', key: 'margin', num: 1, fmt: v => fmt.pct(v) }, { label: 'Revenue', key: 'sales', num: 1, fmt: fmt.idrFull }], rows: items.sort((a, b) => b.disc - a.disc) },
  p => toggle('sub_category', items[p.dataIndex].name, isAdditive(p)));
}

// ===========================================================================
// PAGE: Customers
// ===========================================================================
function customerStats(rows, a, b) {
  const orders = new Map();
  for (const r of rows) { let s = orders.get(r.customer_id); if (!s) orders.set(r.customer_id, s = new Set()); s.add(r.order_id); }
  let repeat = 0, fresh = 0;
  for (const [c, s] of orders) { if (s.size > 1) repeat++; const f = FIRST_ORDER.get(c); if (f >= a && f <= b) fresh++; }
  const sales = rows.reduce((s, r) => s + r.sales, 0);
  return { active: orders.size, repeat: orders.size ? repeat / orders.size : 0, fresh, rpc: orders.size ? sales / orders.size : 0 };
}
function renderCustomers() {
  const { a, b } = period(), pp = prevPeriod();
  const cur = rowsFor('cur'), c = customerStats(cur, a, b), p = pp.ok ? customerStats(rowsFor('prev'), pp.a, pp.b) : null;
  const months = ymRange(state.from, state.to);
  const monthly = monthlySeries(cur, rs => rs);
  renderKpis('kpis-customers', [
    { label: 'Active customers', value: c.active, display: fmt.int(c.active), prev: p?.active, prevDisplay: p && fmt.int(p.active), sparkline: monthly.map(rs => new Set(rs.map(r => r.customer_id)).size) },
    { label: 'New customers', value: c.fresh, display: fmt.int(c.fresh), prev: p?.fresh, prevDisplay: p && fmt.int(p.fresh), sparkline: monthly.map((rs, i) => new Set(rs.filter(r => FIRST_ORDER.get(r.customer_id) === ymToIdx(months[i])).map(r => r.customer_id)).size) },
    { label: 'Repeat-purchase rate', value: c.repeat, display: fmt.pct(c.repeat), prev: p?.repeat, prevDisplay: p && fmt.pct(p.repeat), mode: 'pp' },
    { label: 'Revenue per customer', value: c.rpc, display: fmt.idr(c.rpc, 2), prev: p?.rpc, prevDisplay: p && fmt.idr(p.rpc) },
  ]);

  // new vs returning
  const nw = [], rt = [];
  monthly.forEach((rs, i) => {
    const mi = ymToIdx(months[i]), set = new Map();
    for (const r of rs) set.set(r.customer_id, FIRST_ORDER.get(r.customer_id) === mi);
    let n = 0; for (const v of set.values()) if (v) n++;
    nw.push(n); rt.push(set.size - n);
  });
  setChart('newret', {
    ...baseOpt(),
    grid: { left: 8, right: 16, top: 34, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: T.text2, fontSize: 12 } },
    xAxis: { type: 'category', data: months.map(monthLabel), ...catAxis() },
    yAxis: { type: 'value', ...valAxis() },
    tooltip: { ...baseOpt().tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: T.grid, opacity: 0.5 } },
      formatter: ps => { const i = ps[0].dataIndex, t = nw[i] + rt[i];
        return tipHead(monthLong(months[i])) + tipRow('Returning', `${fmt.int(rt[i])} (${fmt.pct(t ? rt[i] / t : 0, 0)})`, T.series[0]) + tipRow('New', `${fmt.int(nw[i])} (${fmt.pct(t ? nw[i] / t : 0, 0)})`, T.series[1]) + tipRow('Total', fmt.int(t)); } },
    series: [
      { name: 'Returning', type: 'bar', stack: 'c', barMaxWidth: 26, data: rt, itemStyle: { color: T.series[0], borderColor: T.surface, borderWidth: 1 } },
      { name: 'New', type: 'bar', stack: 'c', data: nw, itemStyle: { color: T.series[1], borderColor: T.surface, borderWidth: 1, borderRadius: [4, 4, 0, 0] } },
    ],
  }, { cols: [{ label: 'Month', key: 'm', fmt: monthLong }, { label: 'New', key: 'n', num: 1, fmt: fmt.int }, { label: 'Returning', key: 'r', num: 1, fmt: fmt.int }],
    rows: months.map((m, i) => ({ m, n: nw[i], r: rt[i] })) });

  rankBar('segment', 'segment');
  renderCohort();
  renderPayment();
}

function renderCohort() {
  // cohort = quarter of first order within the current (non-period) filter context
  const rows = rowsFor('all');
  const first = new Map(), active = new Map();
  for (const r of rows) {
    const q = Math.floor(r.mi / 3);
    const f = first.get(r.customer_id); if (f === undefined || q < f) first.set(r.customer_id, q);
    let s = active.get(r.customer_id); if (!s) active.set(r.customer_id, s = new Set()); s.add(q);
  }
  const qMin = Math.floor(MIN_I / 3), qMax = Math.floor(MAX_I / 3), K = qMax - qMin;
  const size = new Array(K + 1).fill(0), ret = Array.from({ length: K + 1 }, () => new Array(K + 1).fill(0));
  for (const [c, f] of first) {
    const ci = f - qMin; size[ci]++;
    for (const q of active.get(c)) { const k = q - f; if (k > 0) ret[ci][k]++; }
  }
  const qLabel = q => `${Math.floor(q / 4)} Q${(q % 4) + 1}`;
  const data = []; let max = 0;
  for (let ci = 0; ci <= K; ci++) for (let k = 1; k <= K - ci; k++) {
    const v = size[ci] ? ret[ci][k] / size[ci] : 0; max = Math.max(max, v);
    data.push([k - 1, ci, +(v * 100).toFixed(1)]);
  }
  const ylabels = size.map((s, ci) => `${qLabel(qMin + ci)} · ${fmt.int(s)}`);
  const thr = max * 100 * 0.55;
  setChart('cohort', {
    ...baseOpt(),
    grid: { left: 8, right: 70, top: 8, bottom: 26, containLabel: true },
    xAxis: { type: 'category', data: Array.from({ length: K }, (_, i) => `+${i + 1}`), ...catAxis({ axisLine: { show: false } }), splitArea: { show: false },
      name: 'Quarters after first order', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: T.muted, fontSize: 11 } },
    yAxis: { type: 'category', data: ylabels, inverse: true, ...catAxis({ axisLine: { show: false } }) },
    visualMap: { min: 0, max: Math.ceil(max * 100), calculable: false, orient: 'vertical', right: 0, top: 'middle', itemHeight: 140, itemWidth: 10,
      text: [Math.ceil(max * 100) + '%', '0%'],
      inRange: { color: [T.seq[0], T.seq[2], T.seq[4], T.seq[6]] }, textStyle: { color: T.muted, fontSize: 11 }, formatter: v => Math.round(v) + '%' },
    tooltip: { ...baseOpt().tooltip, trigger: 'item', formatter: p => { const [k, ci, v] = p.value;
      return tipHead(`Cohort ${qLabel(qMin + ci)}`) + tipRow('Customers acquired', fmt.int(size[ci])) + tipRow(`Ordered again in Q+${k + 1}`, `${fmt.int(ret[ci][k + 1])} (${v}%)`); } },
    series: [{ type: 'heatmap', data: data.map(d => ({ value: d, label: { color: d[2] > thr ? '#ffffff' : T.text } })),
      label: { show: true, fontSize: 10, formatter: p => p.value[2].toFixed(0) + '%' },
      itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 3 } }],
  }, { cols: [{ label: 'Cohort', key: 'c' }, { label: 'Customers', key: 's', num: 1, fmt: fmt.int },
    ...Array.from({ length: K }, (_, k) => ({ label: `Q+${k + 1}`, key: 'k' + (k + 1), num: 1, fmt: v => v == null ? '' : fmt.pct(v, 0) }))],
  rows: size.map((s, ci) => ({ c: qLabel(qMin + ci), s, ...Object.fromEntries(Array.from({ length: K - ci }, (_, k) => ['k' + (k + 1), s ? ret[ci][k + 1] / s : 0])) })) });
}

function renderPayment() {
  const rows = rowsFor('cur', 'payment_method');
  const orders = new Map();
  for (const r of rows) orders.set(r.order_id, r.payment_method);
  const cnt = new Map(); for (const pm of orders.values()) cnt.set(pm, (cnt.get(pm) || 0) + 1);
  const total = orders.size;
  const items = [...cnt.entries()].map(([name, n]) => ({ name, n, share: n / total })).sort((a, b) => a.n - b.n);
  setChart('payment', {
    ...baseOpt(),
    grid: { left: 8, right: 48, top: 4, bottom: 4, containLabel: true },
    yAxis: { type: 'category', data: items.map(i => i.name), ...catAxis() },
    xAxis: { type: 'value', show: false },
    tooltip: { ...baseOpt().tooltip, trigger: 'item', formatter: p => { const i = items[p.dataIndex]; return tipHead(i.name) + tipRow('Orders', fmt.int(i.n)) + tipRow('Share', fmt.pct(i.share)); } },
    series: [{ type: 'bar', barMaxWidth: 18, cursor: 'pointer',
      data: items.map(i => ({ value: i.n, itemStyle: { color: T.series[0], opacity: dimmed('payment_method', i.name) ? 0.25 : 1, borderRadius: [0, 4, 4, 0] } })),
      label: { show: true, position: 'right', color: T.text2, fontSize: 11, formatter: p => fmt.pct(items[p.dataIndex].share) } }],
  }, { cols: [{ label: 'Payment method', key: 'name' }, { label: 'Orders', key: 'n', num: 1, fmt: fmt.int }, { label: 'Share', key: 'share', num: 1, fmt: v => fmt.pct(v) }], rows: [...items].reverse() },
  p => toggle('payment_method', items[p.dataIndex].name, isAdditive(p)));
}

// ===========================================================================
// PAGE: Regional
// ===========================================================================
function deliveryAvg(rows) {
  const o = new Map(); for (const r of rows) if (r.ship_mode !== 'In-Store') o.set(r.order_id, r.delivery_days);
  let s = 0; for (const v of o.values()) s += v; return o.size ? s / o.size : 0;
}
function renderRegional() {
  const cur = rowsFor('cur'), prev = rowsFor('prev'), ok = hasPrev();
  const c = totals(cur), p = ok ? totals(prev) : null;
  const outside = rs => rs.reduce((s, r) => s + (r.region !== 'Java' ? r.sales : 0), 0);
  const provs = rs => new Set(rs.map(r => r.province)).size;
  const oc = outside(cur), op = ok ? outside(prev) : null;
  renderKpis('kpis-regional', [
    { label: 'Provinces with sales', value: provs(cur), display: `${provs(cur)} / 34`, prev: ok ? provs(prev) : null, prevDisplay: ok && String(provs(prev)) },
    { label: 'Revenue outside Java', value: oc, display: fmt.idr(oc, 2), prev: op, prevDisplay: op != null && fmt.idr(op), sparkline: monthlySeries(cur, outside) },
    { label: 'Avg. delivery time', value: deliveryAvg(cur), display: fmt.days(deliveryAvg(cur)), prev: ok ? deliveryAvg(prev) : null, prevDisplay: ok && fmt.days(deliveryAvg(prev)), invert: true, sparkline: monthlySeries(cur, deliveryAvg) },
    { label: 'Return rate', value: c.returnRate, display: fmt.pct(c.returnRate), prev: p?.returnRate, prevDisplay: p && fmt.pct(p.returnRate), mode: 'pp', invert: true, sparkline: monthlySeries(cur, rs => totals(rs).returnRate) },
  ]);
  renderMap(); rankBar('province', 'province', { limit: 12 }); renderMatrix(); renderDelivery();
}

function renderMap() {
  const m = state.mapMetric, ok = hasPrev();
  const cur = aggregate(rowsFor('cur', 'province'), r => r.province), prev = aggregate(rowsFor('prev', 'province'), r => r.province);
  const items = [...cur.entries()].map(([name, a]) => ({ name, sales: a.sales, margin: a.profit / a.sales, orders: a.orders.size, growth: growth(a.sales, prev.get(name)?.sales) }));
  const value = i => m === 'sales' ? i.sales : m === 'margin' ? i.margin : i.growth;
  const vals = items.map(value).filter(v => v != null);
  let vm;
  if (m === 'growth') {
    const ext = Math.max(0.05, ...vals.map(Math.abs));
    vm = { min: -ext, max: ext, inRange: { color: [T.divNeg, T.divMid, T.divPos] }, formatter: v => fmt.signedPct(v, 0) };
  } else {
    vm = { min: m === 'margin' ? Math.min(...vals) : 0, max: Math.max(...vals), inRange: { color: [T.seq[0], T.seq[2], T.seq[4], T.seq[6]] },
      formatter: v => m === 'sales' ? fmt.idr(v, 0) : fmt.pct(v, 0) };
  }
  const option = {
    ...baseOpt(),
    visualMap: { ...vm, left: 8, bottom: 8, itemHeight: 110, itemWidth: 10, calculable: false, textStyle: { color: T.muted, fontSize: 11 }, text: [vm.formatter(vm.max), vm.formatter(vm.min)] },
    tooltip: { ...baseOpt().tooltip, trigger: 'item', formatter: p => { const i = items.find(x => x.name === p.name);
      if (!i) return tipHead(p.name) + `<span style="color:${T.muted}">No sales in selection</span>`;
      return tipHead(i.name) + tipRow('Revenue', fmt.idr(i.sales, 2)) + tipRow('Margin', fmt.pct(i.margin)) + tipRow('Orders', fmt.int(i.orders)) + tipRow('vs prior period', deltaTxt(i.growth)); } },
    series: [{
      type: 'map', map: 'ID', roam: true, scaleLimit: { min: 1, max: 8 }, zoom: 1.12, center: [118, -2.5],
      selectedMode: false, cursor: 'pointer',
      itemStyle: { areaColor: T.surface2, borderColor: T.surface, borderWidth: 0.6 },
      emphasis: { label: { show: true, color: T.text, fontSize: 11, fontWeight: 600 }, itemStyle: { areaColor: T.series[3], borderColor: T.text, borderWidth: 1 } },
      label: { show: false },
      data: items.map(i => ({ name: i.name, value: value(i) ?? undefined, itemStyle: { opacity: dimmed('province', i.name) ? 0.3 : 1 } })),
    }],
  };
  if (m === 'growth' && !ok) option.graphic = [{ type: 'text', right: 12, top: 8, style: { text: 'No prior period available for growth', fill: T.muted, font: '12px Inter' } }];
  setChart('map', option, { cols: [{ label: 'Province', key: 'name' }, { label: 'Revenue', key: 'sales', num: 1, fmt: fmt.idrFull }, { label: 'Margin', key: 'margin', num: 1, fmt: v => fmt.pct(v) },
    { label: 'Orders', key: 'orders', num: 1, fmt: fmt.int }, { label: 'vs prior', key: 'growth', num: 1, fmt: v => v == null ? '—' : fmt.signedPct(v) }], rows: items.sort((a, b) => b.sales - a.sales) },
  p => cur.has(p.name) && toggle('province', p.name, isAdditive(p)));
}

function renderMatrix() {
  const rows = rowsFor('cur', 'region'), prevRows = rowsFor('prev', 'region');
  const prev = aggregate(prevRows, r => r.region);
  const byReg = new Map(); for (const r of rows) { let a = byReg.get(r.region); if (!a) byReg.set(r.region, a = []); a.push(r); }
  const all = totals(rows);
  const items = [...byReg.entries()].map(([name, rs]) => { const t = totals(rs);
    return { name, sales: t.sales, share: t.sales / all.sales, growth: growth(t.sales, prev.get(name)?.sales), profit: t.profit, margin: t.margin,
      orders: t.orders.size, aov: t.aov, delivery: deliveryAvg(rs), returns: t.returnRate }; }).sort((a, b) => b.sales - a.sales);
  const max = Math.max(...items.map(i => i.sales), 1);
  const margins = items.map(i => i.margin), mlo = Math.min(...margins), mhi = Math.max(...margins);
  const heat = v => { const t = mhi > mlo ? (v - mlo) / (mhi - mlo) : 0.5; const idx = Math.round(t * 4);
    return `background:${T.seq[idx]};color:${idx >= 3 ? '#fff' : T.text}`; };
  const pAll = prevRows.length ? growth(all.sales, prevRows.reduce((s, r) => s + r.sales, 0)) : null;
  const pill = g => g == null ? '—' : `<span class="pill ${g >= 0 ? 'up' : 'down'}">${fmt.signedPct(g)}</span>`;
  document.getElementById('t-matrix').innerHTML = `<table><thead><tr><th>Region</th><th class="num">Revenue</th><th class="num">vs prior</th><th class="num">Margin</th>
    <th class="num">Orders</th><th class="num">AOV</th><th class="num">Delivery</th><th class="num">Returns</th></tr></thead><tbody>
    ${items.map(i => `<tr data-region="${esc(i.name)}" style="cursor:pointer;${dimmed('region', i.name) ? 'opacity:.4' : ''}">
      <td>${esc(i.name)}</td>
      <td class="num"><div class="bar-cell"><span>${fmt.idr(i.sales)}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${i.sales / max * 100}%"></span></span></div></td>
      <td class="num">${pill(i.growth)}</td><td class="num"><span class="heat" style="${heat(i.margin)}">${fmt.pct(i.margin)}</span></td>
      <td class="num">${fmt.int(i.orders)}</td><td class="num">${fmt.idr(i.aov)}</td><td class="num">${fmt.days(i.delivery)}</td><td class="num">${fmt.pct(i.returns)}</td></tr>`).join('')}
    <tr class="total"><td>Total</td><td class="num">${fmt.idr(all.sales)}</td><td class="num">${pill(pAll)}</td><td class="num">${fmt.pct(all.margin)}</td>
      <td class="num">${fmt.int(all.orders.size)}</td><td class="num">${fmt.idr(all.aov)}</td><td class="num">${fmt.days(deliveryAvg(rows))}</td><td class="num">${fmt.pct(all.returnRate)}</td></tr>
    </tbody></table>`;
  document.querySelectorAll('#t-matrix tr[data-region]').forEach(tr => tr.addEventListener('click', e => toggle('region', tr.dataset.region, e.ctrlKey || e.metaKey || e.shiftKey)));
  viz.matrix.table = { cols: ['name', 'sales', 'share', 'growth', 'profit', 'margin', 'orders', 'aov', 'delivery', 'returns'].map(k => ({ label: k, key: k })), rows: items };
}

function renderDelivery() {
  const rows = rowsFor('cur').filter(r => r.ship_mode !== 'In-Store');
  const regions = ['Java', 'Sumatra', 'Bali & Nusa Tenggara', 'Kalimantan', 'Sulawesi', 'Maluku & Papua'].filter(r => rows.some(x => x.region === r));
  const modes = Object.keys(SLOT.ship);
  const acc = new Map();
  const seen = new Set();
  for (const r of rows) { if (seen.has(r.order_id)) continue; seen.add(r.order_id);
    const k = r.region + '|' + r.ship_mode; const a = acc.get(k) || { s: 0, n: 0 }; a.s += r.delivery_days; a.n++; acc.set(k, a); }
  const avg = (reg, m) => { const a = acc.get(reg + '|' + m); return a && a.n >= 5 ? +(a.s / a.n).toFixed(2) : null; };
  const short = { 'Bali & Nusa Tenggara': 'Bali & NT', 'Maluku & Papua': 'Maluku & Papua' };
  setChart('delivery', {
    ...baseOpt(),
    grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: T.text2, fontSize: 12 } },
    xAxis: { type: 'category', data: regions.map(r => short[r] || r), ...catAxis(), axisLabel: { color: T.text2, fontSize: 11, interval: 0, width: 72, overflow: 'break' } },
    yAxis: { type: 'value', ...valAxis({ axisLabel: { color: T.muted, fontSize: 11, formatter: v => v + 'd' } }) },
    tooltip: { ...baseOpt().tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: T.grid, opacity: 0.5 } },
      formatter: ps => tipHead(regions[ps[0].dataIndex]) + ps.map(p => tipRow(p.seriesName, p.value == null ? '—' : fmt.days(p.value), p.color)).join('') },
    series: modes.map(m => ({ name: m, type: 'bar', barMaxWidth: 14, barGap: '15%', data: regions.map(r => avg(r, m)),
      itemStyle: { color: T.series[SLOT.ship[m]], borderRadius: [4, 4, 0, 0] } })),
  }, { cols: [{ label: 'Region', key: 'r' }, ...modes.map(m => ({ label: m, key: m, num: 1, fmt: v => v == null ? '—' : fmt.days(v) }))],
    rows: regions.map(r => ({ r, ...Object.fromEntries(modes.map(m => [m, avg(r, m)])) })) });
}

// ===========================================================================
// PAGE: Data
// ===========================================================================
const DATA_COLS = [
  { label: 'Order ID', key: 'order_id' }, { label: 'Date', key: 'order_date' }, { label: 'Customer', key: 'customer_id' },
  { label: 'Segment', key: 'segment' }, { label: 'Channel', key: 'channel' }, { label: 'Region', key: 'region' },
  { label: 'Province', key: 'province' }, { label: 'City', key: 'city' }, { label: 'Category', key: 'category' },
  { label: 'Sub-category', key: 'sub_category' }, { label: 'Product', key: 'product_name' },
  { label: 'Qty', key: 'quantity', num: 1 }, { label: 'Unit price', key: 'unit_price', num: 1, fmt: fmt.idrFull },
  { label: 'Discount', key: 'discount', num: 1, fmt: v => fmt.pct(v, 0) }, { label: 'Sales', key: 'sales', num: 1, fmt: fmt.idrFull },
  { label: 'Profit', key: 'profit', num: 1, fmt: fmt.idrFull }, { label: 'Payment', key: 'payment_method' }, { label: 'Ship mode', key: 'ship_mode' },
];
function dataRows() {
  const q = state.data.q, { sort, dir } = state.data;
  let rs = rowsFor('cur');
  if (q) rs = rs.filter(r => (r.order_id + ' ' + r.product_name + ' ' + r.city + ' ' + r.province + ' ' + r.customer_id).toLowerCase().includes(q));
  return [...rs].sort((a, b) => (a[sort] > b[sort] ? 1 : a[sort] < b[sort] ? -1 : 0) * dir);
}
function renderData() {
  const rows = dataRows(), per = 50, pages = Math.max(1, Math.ceil(rows.length / per));
  state.data.page = Math.min(state.data.page, pages - 1);
  const pg = state.data.page, slice = rows.slice(pg * per, pg * per + per);
  const t = totals(rows);
  document.getElementById('dataInfo').textContent = `${fmt.int(rows.length)} order lines · ${fmt.int(t.orders.size)} orders · revenue ${fmt.idr(t.sales, 2)} · profit ${fmt.idr(t.profit, 2)}`;
  document.getElementById('t-data').innerHTML = `<table><thead><tr>${DATA_COLS.map(c =>
    `<th class="sortable ${c.num ? 'num' : ''} ${state.data.sort === c.key ? 'sorted' + (state.data.dir > 0 ? ' asc' : '') : ''}" data-k="${c.key}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${slice.map(r => `<tr>${DATA_COLS.map(c => `<td class="${c.num ? 'num' : ''}"${c.key === 'profit' && r.profit < 0 ? ` style="color:var(--bad)"` : ''}>${c.fmt ? c.fmt(r[c.key]) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('#t-data th.sortable').forEach(th => th.addEventListener('click', () => {
    const k = th.dataset.k; state.data.dir = state.data.sort === k ? -state.data.dir : -1; state.data.sort = k; renderData();
  }));
  document.getElementById('pager').innerHTML = `<span class="muted">Page ${pg + 1} of ${fmt.int(pages)}</span>
    <button data-d="-1" ${pg === 0 ? 'disabled' : ''}>‹ Prev</button><button data-d="1" ${pg >= pages - 1 ? 'disabled' : ''}>Next ›</button>`;
  document.querySelectorAll('#pager button').forEach(b => b.addEventListener('click', () => { state.data.page += +b.dataset.d; renderData(); }));
}

// ===========================================================================
// Render loop
// ===========================================================================
function renderPage() {
  T = tokens();
  ({ overview: renderOverview, products: renderProducts, customers: renderCustomers, regional: renderRegional, data: renderData })[state.page]();
}
function render() {
  memo = new Map();
  state.data.page = 0;
  syncSlicers();
  writeHash();
  renderPage();
}

(async function init() {
  try {
    await load();
  } catch (e) {
    document.querySelector('#loader p').textContent = 'Could not load data. Serve this folder over HTTP (e.g. `python -m http.server`) and reload.';
    console.error(e); return;
  }
  readHash();
  buildSlicers();
  buildCardMenus();
  bindControls();
  showPage(state.page);
  syncSlicers();
  render();
  document.getElementById('loader').classList.add('done');
})();
