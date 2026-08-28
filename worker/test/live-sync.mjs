// The stall report was that sync only worked after restarting the app. The
// earlier suite reloaded the page on every check, so it exercised exactly the
// path that already worked and never the one that did not.
//
// This one NEVER reloads. It waits.
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
const ARRIVAL_BUDGET_MS = 8000;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

async function phone(deviceId) {
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
  return { page, deviceId, calls };
}

const live = p => p.page.evaluate(() =>
  JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt));

// Waits for a condition without ever reloading the page.
async function waitFor(p, predicate, budget = ARRIVAL_BUDGET_MS) {
  const started = Date.now();
  while (Date.now() - started < budget) {
    if (predicate(await live(p))) return Date.now() - started;
    await p.page.waitForTimeout(400);
  }
  return null;
}

const A = await phone("phoneA");
const B = await phone("phoneB");

console.log("\n1. A customer added on one phone appears on the other, with no reload");
await A.page.bringToFront();
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "Stopped" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await B.page.bringToFront();
let took = await waitFor(B, rows => rows.length === 1);
check("arrived within " + (ARRIVAL_BUDGET_MS / 1000) + "s", took !== null, took === null ? "never arrived" : took + "ms");
if (took !== null) console.log("       (took " + took + "ms)");

console.log("\n2. An edit made on one phone reaches the other, with no reload");
await A.page.bringToFront();
const first = (await live(A))[0];
await A.page.getByText("#" + first.id, { exact: false }).first().click();
await A.page.getByRole("textbox", { name: "note (optional)" }).fill("red hat guy");
await A.page.getByRole("button", { name: "done" }).click();
await B.page.bringToFront();
took = await waitFor(B, rows => rows[0]?.note === "red hat guy");
check("the note caught up", took !== null, took === null ? "never arrived" : took + "ms");

console.log("\n3. A deletion reaches the other phone, with no reload");
await A.page.bringToFront();
await A.page.getByText("#" + first.id, { exact: false }).first().click();
await A.page.getByRole("button", { name: "delete" }).click();
await B.page.bringToFront();
took = await waitFor(B, rows => rows.length === 0);
check("the customer disappeared", took !== null, took === null ? "never arrived" : took + "ms");

console.log("\n4. Polling stops while the app is off screen");
await A.page.bringToFront();          // B is now hidden
await B.page.waitForTimeout(500);
B.calls.length = 0;
await B.page.waitForTimeout(6000);
check("a hidden phone is not polling", B.calls.length === 0, B.calls.length + " requests while hidden");

console.log("\n5. Coming back on screen syncs straight away");
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(900);
const before = Date.now();
await B.page.bringToFront();
took = await waitFor(B, rows => rows.length === 1, 4000);
check("picked up on return without waiting for a tick", took !== null && took < 3000,
  took === null ? "never arrived" : took + "ms");
check("it polled again on becoming visible", B.calls.some(t => t >= before), B.calls.length);

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
