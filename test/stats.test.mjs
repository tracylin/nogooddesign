// The numbers behind the Numbers tab. Pure functions, so no browser here.
// Run with: npm test
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeStats, hourOf, hourLabel } from "../src/stats.js";
import { saleLines, snapshotOf } from "../src/sale.js";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const person = (o = {}) => ({
  uid: "u" + Math.random().toString(36).slice(2, 8),
  time: "12:30 PM", engage: "Stopped", amount: "", payment: "", note: "",
  soldCatalogIds: [], ...o,
});
const sale = (amount, o = {}) => person({ engage: "Bought", amount: String(amount), ...o });

console.log("\n1. Reading the clock off a row");
check("morning", hourOf({ time: "9:05 AM" }) === 9);
check("noon is not midnight", hourOf({ time: "12:08 PM" }) === 12);
check("midnight is not noon", hourOf({ time: "12:40 AM" }) === 0);
check("afternoon", hourOf({ time: "3:59 PM" }) === 15);
check("a 24 hour clock still reads", hourOf({ time: "13:45" }) === 13);
check("falls back to when the row was made",
  hourOf({ time: "", createdAt: new Date(2026, 2, 21, 14, 5).toISOString() }) === 14);
check("gives up rather than guessing", hourOf({ time: "later" }) === null);
check("labels read like a market day", hourLabel(9) + " " + hourLabel(12) + " " + hourLabel(13) === "9am 12pm 1pm");

console.log("\n2. The funnel stacks, because engage is the furthest they got");
const day = [
  person({ engage: "Stopped" }), person({ engage: "Stopped" }),
  person({ engage: "Touched" }),
  person({ engage: "Asked" }),
  sale(40),
  person({ engage: "" }),
];
const s2 = computeStats(day, []);
check("everyone logged is counted", s2.people === 6, s2.people);
check("stopped counts everyone who got at least that far", s2.funnel[0].count === 5, s2.funnel);
check("touched includes the asker and the buyer", s2.funnel[1].count === 3, s2.funnel);
check("asked includes the buyer", s2.funnel[2].count === 2, s2.funnel);
check("bought is only the buyer", s2.funnel[3].count === 1, s2.funnel);
check("the unmarked row is held aside, not invented into a stage", s2.unmarked === 1, s2.unmarked);
check("but it still counts as a person for conversion",
  Math.round(s2.conversion * 1000) / 1000 === Math.round((1 / 6) * 1000) / 1000, s2.conversion);

console.log("\n3. Money comes off the amount, as asked");
const cat3 = [{ id: "a", name: "Hat", category: "Hats", price: 40 }];
const s3 = computeStats([sale(30, { soldCatalogIds: ["a"] }), sale(15)], cat3);
check("a discount is respected over the list price", s3.revenue === 45, s3.revenue);
check("average is per sale", s3.averageSale === 22.5, s3.averageSale);
check("an unreadable amount does not poison the total",
  computeStats([sale("", {}), sale(20)], []).revenue === 20);

console.log("\n4. Deleted rows are gone from the numbers");
const s4 = computeStats([sale(40), { ...sale(100), deletedAt: new Date().toISOString() }], []);
check("a tombstone is not a customer", s4.people === 1, s4.people);
check("and its money does not linger", s4.revenue === 40, s4.revenue);

console.log("\n5. Profit is only claimed where the cost is actually known");
const cat5 = [
  { id: "a", name: "Hat", category: "Hats", price: 40, cost: 12 },
  { id: "b", name: "Ring", category: "Rings", price: 20, cost: 6 },
  { id: "c", name: "Charm", category: "Charms", price: 10 },
];
const s5 = computeStats([
  sale(60, { soldCatalogIds: ["a", "b"] }),
  sale(10, { soldCatalogIds: ["c"] }),
  sale(25),
], cat5);
check("only the fully costed sale is counted", s5.profit.known === 1, s5.profit);
check("the rest are reported as unknown, not as zero cost", s5.profit.unknown === 2, s5.profit);
check("profit is that sale's takings less its costs", s5.profit.amount === 42, s5.profit);
check("margin is over the costed takings only", Math.round(s5.profit.margin * 100) === 70, s5.profit);
check("revenue still counts every sale", s5.revenue === 95, s5.revenue);
check("a sale with no item picked is flagged", s5.salesWithoutItems === 1, s5.salesWithoutItems);
check("with no costs anywhere, profit is simply not known",
  computeStats([sale(40, { soldCatalogIds: ["a"] })], [{ id: "a", name: "Hat", price: 40 }]).profit.known === 0);

console.log("\n6. A restock does not rewrite last month's profit");
const sold = sale(40, {
  soldCatalogIds: ["a"],
  soldItems: [{ id: "a", name: "Hat", price: 40, cost: 12 }],
});
const repriced = [{ id: "a", name: "Hat, remade", category: "Hats", price: 55, cost: 30 }];
const s6 = computeStats([sold], repriced);
check("the cost it sold at is the cost it keeps", s6.profit.amount === 28, s6.profit);
check("and the name it sold under", s6.topItems[0].name === "Hat", s6.topItems);
check("an item dropped from the catalog still shows on the old sale",
  computeStats([sold], []).topItems[0].name === "Hat");
check("snapshots only carry a cost when there is one to carry",
  !("cost" in snapshotOf({ id: "x", name: "X", price: 5 })) && snapshotOf({ id: "x", name: "X", price: 5, cost: 2 }).cost === 2);
check("a code with nothing behind it shows as the code",
  saleLines({ soldCatalogIds: ["ghost"] }, [])[0].name === "ghost");

console.log("\n7. The hours read like the day was actually shaped");
const s7 = computeStats([
  person({ time: "9:10 AM" }),
  sale(20, { time: "12:05 PM" }),
  person({ time: "12:40 PM" }),
  person({ time: "3:00 PM" }),
], []);
check("the range runs from first to last", s7.hours[0].label === "9am" && s7.hours[s7.hours.length - 1].label === "3pm", s7.hours);
check("a quiet hour in the middle is shown empty, not skipped",
  s7.hours.find(h => h.label === "11am") && s7.hours.find(h => h.label === "11am").people === 0, s7.hours);
check("the selling hour knows what it sold", s7.hours.find(h => h.label === "12pm").sales === 1);
check("best hour is where the sales were", s7.bestHour.label === "12pm", s7.bestHour);
check("no sales means no best hour", computeStats([person({ time: "9:10 AM" })], []).bestHour === null);

console.log("\n8. What sold and how it was paid for");
const cat8 = [{ id: "a", name: "Hat", price: 40 }, { id: "b", name: "Ring", price: 20 }];
const s8 = computeStats([
  sale(40, { soldCatalogIds: ["a"], payment: "Venmo" }),
  sale(40, { soldCatalogIds: ["a"], payment: "" }),
  sale(20, { soldCatalogIds: ["b"], payment: "Cash" }),
], cat8);
check("the repeat seller comes first", s8.topItems[0].name === "Hat" && s8.topItems[0].count === 2, s8.topItems);
const disc = computeStats([sale(28, { soldCatalogIds: ["a", "b"] })], [{ id: "a", name: "A", price: 20 }, { id: "b", name: "B", price: 20 }]);
check("a discounted sale credits each item its share, not its list price",
  disc.topItems.every(i => i.revenue === 14), disc.topItems);
check("so the item list adds up to the takings",
  disc.topItems.reduce((t, i) => t + i.revenue, 0) === disc.revenue, [disc.topItems, disc.revenue]);
const uneven = computeStats([sale(30, { soldCatalogIds: ["a", "b"] })], [{ id: "a", name: "A", price: 40 }, { id: "b", name: "B", price: 20 }]);
check("an uneven bundle splits in proportion to what things are marked at",
  uneven.topItems[0].revenue === 20 && uneven.topItems[1].revenue === 10, uneven.topItems);
check("a blank payment is named rather than hidden",
  s8.payments.some(p => p.label === "not recorded" && p.count === 1), s8.payments);
check("payment totals add up", s8.payments.reduce((t, p) => t + p.amount, 0) === 100, s8.payments);

console.log("\n9. An empty day does not throw");
const s9 = computeStats([], []);
check("no people", s9.people === 0);
check("no average to report", s9.averageSale === null);
check("no hours to draw", s9.hours.length === 0);
check("conversion is zero, not NaN", s9.conversion === 0);
check("undefined is survivable", computeStats(undefined).people === 0);

console.log("\n10. The real March market, against the numbers we already know");
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "march-day.json");
if (existsSync(fixture)) {
  const rows = JSON.parse(readFileSync(fixture, "utf8"));
  const m = computeStats(rows, []);
  check("100 people", m.people === 100, m.people);
  check("12 sales", m.sales === 12, m.sales);
  check("$291 taken", m.revenue === 291, m.revenue);
  check("$24.25 a sale", m.averageSale === 24.25, m.averageSale);
  check("12% conversion", (m.conversion * 100).toFixed(1) === "12.0", m.conversion);
  check("the funnel opens at 96", m.funnel[0].count === 96, m.funnel);
  check("four rows never got a stage", m.unmarked === 4, m.unmarked);
  check("the day ran 9am to 3pm", m.hours.length === 7, m.hours.map(h => h.label));
  check("the selling ran from 10am to 2pm",
    m.hours.filter(h => h.sales > 0).map(h => h.label).join() === "10am,12pm,1pm,2pm", m.hours.map(h => h.label + ":" + h.sales));
  check("half the day's sales fell in the noon hour and the one after",
    m.hours.filter(h => ["12pm", "1pm"].includes(h.label)).reduce((t, h) => t + h.sales, 0) === 10, m.hours.map(h => h.label + ":" + h.sales));
  check("the shop's own end of day agrees on the split",
    m.stages.Stopped === 32 && m.stages.Touched === 50 && m.stages.Asked === 2 && m.stages.Bought === 12, m.stages);
  check("Venmo three, cash one, the rest not written down",
    m.payments.find(p => p.label === "Venmo")?.count === 3 &&
    m.payments.find(p => p.label === "Cash")?.count === 1 &&
    m.payments.find(p => p.label === "not recorded")?.count === 8, m.payments);
  check("profit is unknown when the numbers are asked without a catalog", m.profit.known === 0, m.profit);

  // The same day read through the real catalog, which now carries a cost per
  // item. These sales kept no snapshot, so they resolve through the catalog and
  // the profit is worked out for the first time here.
  const appSrc = readFileSync(join(here, "..", "src", "App.jsx"), "utf8");
  const at = appSrc.indexOf("const CATALOGS = [");
  const catBlock = appSrc.slice(at, appSrc.indexOf("\n];", at) + 3);
  const CATALOGS = new Function(catBlock + "\nreturn CATALOGS;")();
  const catalogFor = day => {
    let chosen = CATALOGS[0];
    for (const c of CATALOGS) if (String(day) >= c.from) chosen = c;
    return chosen.items;
  };
  const CATALOG = catalogFor("2026-03-21");
  check("the day is read through the shelf it had, not the one in the shop now",
    CATALOG.length === 73 && catalogFor("2026-09-05").length > 73,
    [CATALOG.length, catalogFor("2026-09-05").length]);
  check("a day before any catalog still gets one", catalogFor("2020-01-01").length === 73);
  check("every item on every shelf carries a cost",
    CATALOGS.every(c => c.items.every(i => typeof i.cost === "number")),
    CATALOGS.flatMap(c => c.items).filter(i => typeof i.cost !== "number").map(i => i.id));
  check("no id means two different things across the shelves", (() => {
    const seen = new Map();
    for (const c of CATALOGS) for (const i of c.items) {
      const was = seen.get(i.id);
      if (was && was !== i.name) return false;
      seen.set(i.id, i.name);
    }
    return true;
  })());
  const withCost = computeStats(rows, CATALOG);
  check("eleven of the twelve sales can be costed", withCost.profit.known === 11, withCost.profit);
  check("cost of goods is $115.38, the same figure the shop wrote down",
    withCost.profit.cost === 115.38, withCost.profit.cost);
  check("profit is $173.62", withCost.profit.amount === 173.62, withCost.profit.amount);
  check("margin is 60%", Math.round(withCost.profit.margin * 100) === 60, withCost.profit.margin);
  check("the water bottle stays out of it, having no item and so no cost",
    withCost.profit.revenue === 289 && withCost.revenue === 291, [withCost.profit.revenue, withCost.revenue]);
} else {
  console.log("  skip fixture, test/fixtures/march-day.json not present");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
