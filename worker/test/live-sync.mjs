// The stall report was that sync only worked after restarting the app. The
// earlier suite reloaded the page on every check, so it exercised exactly the
// path that already worked and never the one that did not.
//
// This one NEVER reloads. It waits.
//
// Each phone gets its own browser context. Two pages in one context share an
// origin's local storage, which would make one phone appear to "receive" what
// the other merely wrote, and the test would pass without any syncing at all.
//
//   cd worker && npm install && npm run dev          # terminal 1
//   npm run build && npx serve dist -l 5173          # terminal 2
//   npm install --no-save playwright                 # terminal 3
//   node worker/test/live-sync.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";
const WORKER = process.env.SYNC_URL || "http://127.0.0.1:8787";
const STALL = "live-" + Math.random().toString(36).slice(2, 10);
const MARKET = "2026-08-28";
const BUDGET_MS = 9000;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

async function phone(deviceId) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const calls = [];
  page.on("request", r => { if (r.url().includes("/sync")) calls.push(Date.now()); });
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
  calls.length = 0;
  return { ctx, page, deviceId, calls };
}

const live = p => p.page.evaluate(() =>
  JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt));

// Waits for a condition without ever reloading the page.
async function waitFor(p, predicate, budget = BUDGET_MS) {
  const started = Date.now();
  while (Date.now() - started < budget) {
    if (predicate(await live(p))) return Date.now() - started;
    await p.page.waitForTimeout(300);
  }
  return null;
}

// Headless Chrome does not reliably report a background page as hidden, so the
// visibility handling is driven directly rather than through tab focus.
const setVisibility = (p, state) => p.page.evaluate((v) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);

const A = await phone("phoneA");
const B = await phone("phoneB");

console.log("\n0. The two phones really are separate");
await A.page.evaluate(() => localStorage.setItem("ngd_isolation_probe", "A"));
check("they do not share local storage",
  (await B.page.evaluate(() => localStorage.getItem("ngd_isolation_probe"))) === null);

console.log("\n1. A customer added on one phone appears on the other, with no reload");
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "Stopped" }).click();
await A.page.getByRole("button", { name: "done" }).click();
let took = await waitFor(B, rows => rows.length === 1);
check("arrived without a reload", took !== null, took === null ? "never arrived" : took + "ms");
if (took !== null) console.log("       (took " + took + "ms)");

console.log("\n2. An edit made on one phone reaches the other, with no reload");
const first = (await live(A))[0];
await A.page.getByText("#" + first.id, { exact: false }).first().click();
await A.page.getByRole("textbox", { name: "note (optional)" }).fill("red hat guy");
await A.page.getByRole("button", { name: "done" }).click();
took = await waitFor(B, rows => rows[0]?.note === "red hat guy");
check("the note caught up", took !== null, took === null ? "never arrived" : took + "ms");

console.log("\n3. A deletion reaches the other phone, with no reload");
await A.page.getByText("#" + first.id, { exact: false }).first().click();
await A.page.getByRole("button", { name: "delete" }).click();
took = await waitFor(B, rows => rows.length === 0);
check("the customer disappeared", took !== null, took === null ? "never arrived" : took + "ms");

console.log("\n4. Polling stops while the app is off screen");
await setVisibility(B, "hidden");
await B.page.waitForTimeout(300);
B.calls.length = 0;
await B.page.waitForTimeout(6000);
check("a hidden phone is not polling", B.calls.length === 0, B.calls.length + " requests while hidden");

console.log("\n5. Coming back on screen syncs straight away");
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(1200);
check("the sleeping phone did not see it yet", (await live(B)).length === 0, await live(B));

const before = Date.now();
await setVisibility(B, "visible");
took = await waitFor(B, rows => rows.length === 1, 4000);
check("picked up on waking, without waiting for a tick", took !== null && took < 2500,
  took === null ? "never arrived" : took + "ms");
check("it polled again the moment it woke", B.calls.some(t => t >= before), B.calls.length);

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
