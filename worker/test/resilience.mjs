// Edge cases that only show up on a bad network, which is the network a market
// stall actually has.
//
//   cd worker && npm install && npm run dev          # terminal 1
//   npm run build && npx serve dist -l 5173          # terminal 2
//   npm install --no-save playwright                 # terminal 3
//   node worker/test/resilience.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";
const WORKER = process.env.SYNC_URL || "http://127.0.0.1:8787";
const STALL = "resil-" + Math.random().toString(36).slice(2, 10);
const MARKET = "2026-08-28";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

async function phone(deviceId) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => { console.log("  [" + deviceId + " page error] " + e.message); fail++; });
  await page.goto(APP);
  await page.evaluate(([url, stall, market, dev]) => {
    localStorage.clear();
    localStorage.setItem("ngd_sync_url", url);
    localStorage.setItem("ngd_stall_key", stall);
    localStorage.setItem("ngd_market", market);
    localStorage.setItem("ngd_device_id", dev);
  }, [WORKER, STALL, MARKET, deviceId]);
  await page.reload();
  await page.waitForTimeout(800);
  return { ctx, page, deviceId };
}

const state = p => p.page.evaluate(() => ({
  live: JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt),
  unsent: JSON.parse(localStorage.getItem("ngd_dirty") || "[]").length,
}));

async function waitFor(p, predicate, budget = 9000) {
  const started = Date.now();
  while (Date.now() - started < budget) {
    if (predicate(await state(p))) return Date.now() - started;
    await p.page.waitForTimeout(300);
  }
  return null;
}

const A = await phone("phoneA");
const B = await phone("phoneB");

console.log("\n1. A request that is accepted and then never answered");
// Not a refused connection: the socket opens and stays silent, which is what a
// weak mobile signal actually does, and what a fetch with no deadline waits on
// forever.
const held = [];
await A.page.route("**/sync**", route => { held.push(route); });
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "Stopped" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(2000);
let s = await state(A);
check("the customer is still recorded on this phone", s.live.length === 1, s.live.length);
check("and is queued to send", s.unsent === 1, s.unsent);
check("the other phone has not seen it", (await state(B)).live.length === 0);

console.log("\n2. Sync recovers once the network does, with no restart");
// Before the timeout was added, one hung request held the only sync slot for
// good and nothing synced again until the app was restarted.
await A.page.waitForTimeout(12000);
const showsTrouble = await A.page.getByText("offline", { exact: false }).first().isVisible().catch(() => false);
check("the phone admits something is wrong", showsTrouble);
await A.page.unroute("**/sync**");
const took = await waitFor(A, st => st.unsent === 0, 12000);
check("the queue drains by itself", took !== null, took === null ? "still stuck" : took + "ms");
check("the customer reaches the other phone", (await waitFor(B, st => st.live.length === 1)) !== null,
  (await state(B)).live.length);

console.log("\n3. Clearing this phone also clears what it was waiting to send");
await B.page.route("**/sync**", route => route.abort());
await B.page.getByRole("button", { name: "✲" }).click();
await B.page.getByRole("button", { name: "done" }).click();
await B.page.waitForTimeout(1500);
check("something is queued", (await state(B)).unsent >= 1, (await state(B)).unsent);
B.page.once("dialog", d => d.accept());
await B.page.getByRole("button", { name: "" }).first().click().catch(() => {});
await B.page.evaluate(() => {
  const gear = [...document.querySelectorAll("button")].find(b => b.querySelector("svg"));
  if (gear) gear.click();
});
await B.page.waitForTimeout(300);
B.page.once("dialog", d => d.accept());
await B.page.getByRole("button", { name: "Clear local" }).click();
await B.page.waitForTimeout(600);
s = await state(B);
check("the list is empty", s.live.length === 0, s.live.length);
check("and nothing is left waiting to send", s.unsent === 0, s.unsent);

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
