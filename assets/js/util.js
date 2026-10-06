// ---------------------------------------------------------------------------
// Formatting, theme tokens and small aggregation helpers
// ---------------------------------------------------------------------------

export const fmt = {
  idr(v, digits = 1) {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e12) return `${s}Rp${(a / 1e12).toFixed(digits)}T`;
    if (a >= 1e9) return `${s}Rp${(a / 1e9).toFixed(digits)}B`;
    if (a >= 1e6) return `${s}Rp${(a / 1e6).toFixed(digits)}M`;
    if (a >= 1e3) return `${s}Rp${(a / 1e3).toFixed(0)}K`;
    return `${s}Rp${a.toFixed(0)}`;
  },
  // axis ticks: keep one decimal only when needed so 2.5B and 3B never collapse to the same label
  idrAxis(v) { return fmt.idr(v, 1).replace(/\.0(?=[TBMK])/, ''); },
  idrFull: v => 'Rp' + Math.round(v).toLocaleString('id-ID'),
  int: v => Math.round(v).toLocaleString('en-US'),
  compact(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return Math.round(v).toLocaleString('en-US');
  },
  pct: (v, d = 1) => (v * 100).toFixed(d) + '%',
  signedPct: (v, d = 1) => (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%',
  pp: (v, d = 1) => (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + ' pp',
  days: v => v.toFixed(1) + ' d',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = ym => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}`;
export const monthLong = ym => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

// month arithmetic on "YYYY-MM" keys
export const ymToIdx = ym => (+ym.slice(0, 4)) * 12 + (+ym.slice(5, 7) - 1);
export const idxToYm = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const ymRange = (a, b) => { const out = []; for (let i = ymToIdx(a); i <= ymToIdx(b); i++) out.push(idxToYm(i)); return out; };
export const quarterOf = ym => `${ym.slice(0, 4)} Q${Math.floor((+ym.slice(5, 7) - 1) / 3) + 1}`;

/** Read the CSS design tokens so charts follow the active theme. */
export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  return {
    surface: g('--surface-1'), surface2: g('--surface-2'), border: g('--border'), borderStrong: g('--border-strong'),
    text: g('--text-primary'), text2: g('--text-secondary'), muted: g('--text-muted'), grid: g('--grid'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => g(`--series-${i}`)), prev: g('--series-prev'),
    seq: [1, 2, 3, 4, 5, 6, 7].map(i => g(`--seq-${i}`)),
    divNeg: g('--div-neg'), divMid: g('--div-mid'), divPos: g('--div-pos'),
    good: g('--good'), bad: g('--bad'), warn: g('--warn'),
    dark: document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches),
  };
}

/**
 * Group rows and compute the standard measure set.
 * Returns Map<key, {sales, profit, cost, qty, orders:Set, customers:Set, n, disc}>
 */
export function aggregate(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let a = m.get(k);
    if (!a) { a = { sales: 0, profit: 0, qty: 0, orders: new Set(), customers: new Set(), n: 0, gross: 0 }; m.set(k, a); }
    a.sales += r.sales; a.profit += r.profit; a.qty += r.quantity; a.n++;
    a.gross += r.unit_price * r.quantity;
    a.orders.add(r.order_id); a.customers.add(r.customer_id);
  }
  return m;
}

export function totals(rows) {
  const t = { sales: 0, profit: 0, qty: 0, gross: 0, orders: new Set(), customers: new Set(), returnedOrders: new Set() };
  for (const r of rows) {
    t.sales += r.sales; t.profit += r.profit; t.qty += r.quantity; t.gross += r.unit_price * r.quantity;
    t.orders.add(r.order_id); t.customers.add(r.customer_id);
    if (r.returned) t.returnedOrders.add(r.order_id);
  }
  t.margin = t.sales ? t.profit / t.sales : 0;
  t.aov = t.orders.size ? t.sales / t.orders.size : 0;
  t.discount = t.gross ? 1 - t.sales / t.gross : 0;
  t.returnRate = t.orders.size ? t.returnedOrders.size / t.orders.size : 0;
  return t;
}

export const growth = (cur, prev) => (prev ? cur / prev - 1 : null);

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function downloadCsv(filename, cols, rows) {
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.map(c => q(c.label)).join(','), ...rows.map(r => cols.map(c => q(c.raw ? c.raw(r) : r[c.key])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
