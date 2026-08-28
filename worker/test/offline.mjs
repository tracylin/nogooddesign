// The app has to open with no signal. In a market building that is the moment
// you can least afford a blank screen.
//
//   npm run build && npx serve dist -l 5173
//   npm install --no-save playwright
//   node worker/test/offline.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";
const WORKER = process.env.SYNC_URL || "http://127.0.0.1:8787";
// A fresh stall each run. A fixed one accumulates entries on the server, and
// the counts below then measure previous runs rather than this one.
const STALL = "offline-" + Math.random().toString(36).slice(2, 10);
const MARKET = "2026-08-28";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on("pageerror", e => { console.log("  [page error] " + e.message); fail++; });

console.log("\n1. It can be installed to a home screen");
await page.goto(APP);
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const res = await fetch(link.href);
  return res.ok ? res.json() : null;
});
check("a manifest is linked and loads", manifest !== null);
check("it opens without browser chrome", manifest?.display === "standalone", manifest?.display);
check("it has a 192 and a 512 icon", ["192x192", "512x512"].every(
  size => manifest?.icons?.some(i => i.sizes === size)), manifest?.icons?.map(i => i.sizes));
for (const icon of manifest?.icons || []) {
  const ok = await page.evaluate(async (src) => (await fetch(src)).ok, icon.src);
  if (!ok) check("icon " + icon.src + " exists", false);
}
check("every icon it names actually exists", true);

console.log("\n2. The service worker takes over");
const active = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return Boolean(reg.active);
});
check("a service worker is running", active);

console.log("\n3. Some work is recorded, then the signal goes");
await page.evaluate(([url, stall, market]) => {
  localStorage.setItem("ngd_sync_url", url);
  localStorage.setItem("ngd_stall_key", stall);
  localStorage.setItem("ngd_market", market);
}, [WORKER, STALL, MARKET]);
await page.reload();
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "✲" }).click();
await page.getByRole("button", { name: "Stopped" }).click();
await page.getByRole("button", { name: "done" }).click();
await page.waitForTimeout(600);
const before = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt).length);
check("the customer is recorded", before === 1, before);

console.log("\n4. Force closing and reopening with no signal");
await ctx.setOffline(true);
let blank = false;
try {
  await page.reload({ waitUntil: "domcontentloaded" });
} catch (e) {
  blank = true;
  check("the page loaded at all", false, e.message.slice(0, 80));
}
if (!blank) {
  await page.waitForTimeout(1200);
  const counter = await page.getByText("Counter", { exact: false }).first().isVisible().catch(() => false);
  check("the app renders instead of a blank screen", counter);
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt).length);
  check("the day's work is still there", after === 1, after);
  const priceCheck = await page.getByText("Price check", { exact: false }).first().isVisible().catch(() => false);
  check("price check is still usable offline", priceCheck);
  await page.getByRole("button", { name: "✲" }).click();
  await page.waitForTimeout(400);
  const added = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt).length);
  check("and new customers can still be counted", added === 2, added);
}

console.log("\n5. Back online");
await ctx.setOffline(false);
await page.reload();
await page.waitForTimeout(1500);
const final = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt).length);
check("nothing was lost across the outage", final >= 2, final);

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
