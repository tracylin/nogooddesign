// An inventory update changes what is in stock. It must not change what already
// happened. Items that sold out and were not restocked disappear from the
// catalog, and prices move, but a recorded sale has to keep saying what was
// sold and what it went for.
//
//   npm run build && npx serve dist -l 5173
//   npm install --no-save playwright
//   node worker/test/inventory-change.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on("pageerror", e => { console.log("  [page error] " + e.message); fail++; });
await page.goto(APP);
await page.waitForTimeout(400);

console.log("\n1. A sale records what went into it");
await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ngd_market", "2026-08-28"); });
await page.reload();
await page.waitForTimeout(700);
await page.getByRole("button", { name: "✲" }).click();
await page.getByRole("button", { name: "Bought" }).click();
await page.getByRole("button", { name: "Select items from catalog" }).click();
await page.waitForTimeout(300);
// Two named catalog items, so the test does not depend on row layout.
const PICKED = ["GENTLE GARGAR", "BLINDNOPLAN 25SS"];
for (const name of PICKED) {
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(200);
}
await page.getByRole("button", { name: "Done", exact: true }).click();
await page.getByRole("button", { name: "done", exact: true }).click();
await page.waitForTimeout(600);

const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("ngd_entries"))[0]);
check("two items were picked", (saved.soldCatalogIds || []).length === 2, saved.soldCatalogIds);
check("they are the ones chosen", (saved.soldItems || []).map(i => i.name).sort().join("|") === PICKED.slice().sort().join("|"), (saved.soldItems || []).map(i => i.name));
check("the sale kept a record of them", Array.isArray(saved.soldItems) && saved.soldItems.length === 2, saved.soldItems);
check("with their names", (saved.soldItems || []).every(i => i.name && i.name !== i.id), saved.soldItems);
check("and the price they sold at", (saved.soldItems || []).every(i => "price" in i), saved.soldItems);

console.log("\n2. The inventory is updated: one item sold out and is gone, the other is repriced");
await page.evaluate(() => {
  const entries = JSON.parse(localStorage.getItem("ngd_entries"));
  const e = entries[0];
  // Item one no longer exists in the catalog at all. Item two is still there.
  e.soldCatalogIds = ["retired-item", e.soldCatalogIds[1]];
  e.soldItems = [{ id: "retired-item", name: "逃跑乐园 (1)", price: 40 }, e.soldItems[1]];
  localStorage.setItem("ngd_entries", JSON.stringify(entries));
});
await page.reload();
await page.waitForTimeout(800);

const row = await page.getByText("#1", { exact: false }).first().textContent();
check("the retired item still shows in the list", row.includes("逃跑乐园"), row);

await page.getByText("#1", { exact: false }).first().click();
await page.waitForTimeout(400);
const body = await page.evaluate(() => document.body.innerText);
check("the sale still says two items", /2 items selected/.test(body), (body.match(/\d+ items? selected/) || [])[0]);
check("the retired item is named, not dropped", body.includes("逃跑乐园"), false);
check("and still shows what it sold for", body.includes("$40"), false);

console.log("\n3. Nothing was quietly rewritten");
const after = await page.evaluate(() => JSON.parse(localStorage.getItem("ngd_entries"))[0]);
check("the recorded price is unchanged", after.soldItems[0].price === 40, after.soldItems[0]);
check("the amount is unchanged", after.amount === saved.amount, [saved.amount, after.amount]);

console.log("\n4. An item with no record and no catalog entry shows its code rather than vanishing");
await page.evaluate(() => {
  const entries = JSON.parse(localStorage.getItem("ngd_entries"));
  entries[0].soldCatalogIds = ["ghost-9"];
  delete entries[0].soldItems;
  localStorage.setItem("ngd_entries", JSON.stringify(entries));
});
await page.reload();
await page.waitForTimeout(800);
await page.getByText("#1", { exact: false }).first().click();
await page.waitForTimeout(400);
const ghost = await page.evaluate(() => document.body.innerText);
check("it is still counted", /1 item selected/.test(ghost), (ghost.match(/\d+ items? selected/) || [])[0]);
check("and identified", ghost.includes("ghost-9"), false);

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
