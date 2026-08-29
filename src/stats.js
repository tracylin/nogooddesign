// The numbers behind the Numbers tab. Pure functions over one market day's
// entries, so they run on the phone with no signal and are testable without a
// browser. Everything here reads the day currently loaded, never a running
// total across markets.
import { saleLines, costOf } from "./sale.js";

export const STAGES = ["Stopped", "Touched", "Asked", "Bought"];

const round2 = v => Math.round(v * 100) / 100;

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

function label(entry) {
  return String((entry && entry.engage) || "").trim();
}

export function hourLabel(h) {
  if (h === 0) return "12am";
  if (h < 12) return h + "am";
  if (h === 12) return "12pm";
  return (h - 12) + "pm";
}

// The row shows a time like "12:08 PM", so that is what the hour is read from.
// createdAt is the fallback for rows that never got one.
export function hourOf(entry) {
  const raw = String((entry && entry.time) || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (m) {
    const h12 = parseInt(m[1], 10) % 12;
    return m[3].toLowerCase() === "p" ? h12 + 12 : h12;
  }
  const plain = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (plain) {
    const h = parseInt(plain[1], 10);
    if (h >= 0 && h < 24) return h;
  }
  if (entry && entry.createdAt) {
    const d = new Date(entry.createdAt);
    if (!isNaN(d.getTime())) return d.getHours();
  }
  return null;
}

export function computeStats(entries, catalog = []) {
  const live = (entries || []).filter(e => e && !e.deletedAt);
  const people = live.length;

  const stages = {};
  STAGES.forEach(s => { stages[s] = 0; });
  let unmarked = 0;
  live.forEach(e => {
    const l = label(e);
    if (Object.prototype.hasOwnProperty.call(stages, l)) stages[l] += 1;
    else unmarked += 1;
  });

  // engage records the furthest stage a person reached, so the stages stack:
  // whoever bought also stopped, touched and asked on the way there.
  const funnel = STAGES.map((stage, i) => ({
    stage,
    count: STAGES.slice(i).reduce((t, s) => t + stages[s], 0),
  }));

  const sold = live.filter(e => label(e) === "Bought");
  const sales = sold.length;
  const revenue = sold.reduce((t, e) => t + (num(e.amount) || 0), 0);

  // Profit is only claimed for sales where every item carries a known cost. One
  // costed item beside an uncosted one would otherwise report the uncosted piece
  // as pure margin and quietly inflate the day.
  let costedSales = 0, costedRevenue = 0, costedCost = 0, noItems = 0;
  sold.forEach(e => {
    const lines = saleLines(e, catalog);
    if (!lines.length) { noItems += 1; return; }
    if (!lines.every(l => costOf(l) !== null)) return;
    costedSales += 1;
    costedRevenue += num(e.amount) || 0;
    costedCost += lines.reduce((t, l) => t + costOf(l), 0);
  });
  const profit = {
    known: costedSales,
    unknown: sales - costedSales,
    revenue: round2(costedRevenue),
    cost: round2(costedCost),
    amount: round2(costedRevenue - costedCost),
    margin: costedRevenue > 0 ? (costedRevenue - costedCost) / costedRevenue : null,
  };

  const byHour = new Map();
  live.forEach(e => {
    const h = hourOf(e);
    if (h === null) return;
    if (!byHour.has(h)) byHour.set(h, { hour: h, label: hourLabel(h), people: 0, sales: 0, revenue: 0 });
    const b = byHour.get(h);
    b.people += 1;
    if (label(e) === "Bought") { b.sales += 1; b.revenue += num(e.amount) || 0; }
  });
  // Quiet hours in the middle of the day are part of the shape, so the range is
  // filled in rather than collapsed.
  const active = [...byHour.keys()].sort((a, b) => a - b);
  const hours = [];
  for (let h = active[0]; active.length && h <= active[active.length - 1]; h++) {
    hours.push(byHour.get(h) || { hour: h, label: hourLabel(h), people: 0, sales: 0, revenue: 0 });
  }
  hours.forEach(h => { h.revenue = round2(h.revenue); });
  const bestHour = hours.filter(h => h.sales > 0)
    .sort((a, b) => b.sales - a.sales || b.revenue - a.revenue)[0] || null;

  // What a sale actually took is the amount, and a two hat bundle at five off
  // took less than the two list prices. Each item is credited its share of what
  // came in rather than what it was marked at, so this list adds up to the day's
  // takings instead of overstating every discount.
  const items = new Map();
  sold.forEach(e => {
    const lines = saleLines(e, catalog);
    if (!lines.length) return;
    const priceOf = l => (typeof l.price === "number" && isFinite(l.price) ? l.price : 0);
    const amount = num(e.amount);
    const listed = lines.reduce((t, l) => t + priceOf(l), 0);
    lines.forEach(l => {
      if (!items.has(l.id)) items.set(l.id, { id: l.id, name: l.name, count: 0, revenue: 0 });
      const it = items.get(l.id);
      it.count += 1;
      if (amount === null) it.revenue += priceOf(l);
      else if (listed > 0) it.revenue += amount * (priceOf(l) / listed);
      else it.revenue += amount / lines.length;
    });
  });
  const topItems = [...items.values()]
    .sort((a, b) => b.count - a.count || b.revenue - a.revenue)
    .map(i => ({ ...i, revenue: round2(i.revenue) }));

  const pay = new Map();
  sold.forEach(e => {
    const l = String(e.payment || "").trim() || "not recorded";
    if (!pay.has(l)) pay.set(l, { label: l, count: 0, amount: 0 });
    const p = pay.get(l);
    p.count += 1;
    p.amount += num(e.amount) || 0;
  });
  const payments = [...pay.values()]
    .sort((a, b) => b.count - a.count)
    .map(p => ({ ...p, amount: round2(p.amount) }));

  return {
    people, stages, unmarked, funnel,
    sales, revenue: round2(revenue),
    averageSale: sales ? round2(revenue / sales) : null,
    conversion: people ? sales / people : 0,
    profit, salesWithoutItems: noItems,
    hours, bestHour, topItems, payments,
  };
}
