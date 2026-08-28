// Market days must stay apart, and a day must be restorable from a file.
// Without the first, every market piles into one list. Without the second, a
// backup is only half a backup.
//
//   cd worker && npm install && npm run dev          # terminal 1
//   npm run build && npx serve dist -l 5173          # terminal 2
//   npm install --no-save playwright                 # terminal 3
//   node worker/test/market-days.mjs
import { chromium } from "playwright";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";
const WORKER = process.env.SYNC_URL || "http://127.0.0.1:8787";
const STALL = "days-" + Math.random().toString(36).slice(2, 10);

const today = new Date();
const iso = d => d.toISOString().slice(0, 10);
const TODAY = iso(today);
const YESTERDAY = iso(new Date(today.getTime() - 864e5));
const TOMORROW = iso(new Date(today.getTime() + 864e5));
const LONG_AGO = "2026-03-21";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

async function phone(deviceId, market) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("dialog", d => d.accept());
  page.on("pageerror", e => { console.log("  [" + deviceId + " page error] " + e.message); fail++; });
  await page.goto(APP);
  await page.evaluate(([url, stall, day, dev]) => {
    localStorage.clear();
    localStorage.setItem("ngd_sync_url", url);
    localStorage.setItem("ngd_stall_key", stall);
    localStorage.setItem("ngd_market", day);
    localStorage.setItem("ngd_device_id", dev);
  }, [WORKER, STALL, market, deviceId]);
  await page.reload();
  await page.waitForTimeout(900);
  return { ctx, page, deviceId };
}

const state = p => p.page.evaluate(() => ({
  market: localStorage.getItem("ngd_market"),
  live: JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt),
}));

async function waitFor(p, predicate, budget = 9000) {
  const started = Date.now();
  while (Date.now() - started < budget) {
    if (predicate(await state(p))) return Date.now() - started;
    await p.page.waitForTimeout(300);
  }
  return null;
}

const openSettings = p => p.page.evaluate(() => {
  const gear = [...document.querySelectorAll("button")].find(b => b.querySelector("svg"));
  gear?.click();
});
const closeSettings = async p => {
  await p.page.getByRole("button", { name: "✕" }).first().click().catch(() => {});
  await p.page.waitForTimeout(200);
};

console.log("\n1. A phone left on yesterday is told, not left counting into it");
const A = await phone("phoneA", YESTERDAY);
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(900);
check("the stale day is called out", await A.page.getByText("It is a new day", { exact: false }).first().isVisible());
check("and it offers today", await A.page.getByRole("button", { name: "Start " + TODAY }).isVisible());

console.log("\n2. Starting the new day leaves yesterday behind, on the server");
await A.page.getByRole("button", { name: "Start " + TODAY }).click();
await A.page.waitForTimeout(1200);
let a = await state(A);
check("the phone is on today", a.market === TODAY, a.market);
check("today starts empty", a.live.length === 0, a.live.length);
const listed = await (await fetch(`${WORKER}/markets?stall=${STALL}`)).json();
check("yesterday is still held on the server",
  listed.markets.some(m => m.market === YESTERDAY && m.entries === 1), listed.markets);

console.log("\n3. The second phone catches up rather than counting into the old day");
const B = await phone("phoneB", YESTERDAY);
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(1000);
check("the second phone is told its day is stale",
  await B.page.getByText("It is a new day", { exact: false }).first().isVisible());
await B.page.getByRole("button", { name: "Start " + TODAY }).click();
let caught = await waitFor(B, st => st.market === TODAY && st.live.length === 1);
check("and picks up today's customer", caught !== null, caught === null ? await state(B) : caught + "ms");

console.log("\n4. One phone opening a later day pulls the other along");
// Only the server can tell a phone about this: today is not stale, so nothing
// on the phone itself would ever hint that the market has moved.
await openSettings(A);
await A.page.fill('input[type="date"]', TOMORROW);
await A.page.waitForTimeout(1200);
await closeSettings(A);
check("the first phone moved", (await state(A)).market === TOMORROW, (await state(A)).market);
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(1200);
await B.page.reload();
const noticed = await B.page.getByText("Another phone has started", { exact: false }).first()
  .waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
check("the second phone hears about it from the server", noticed);
if (noticed) {
  await B.page.getByRole("button", { name: "Start " + TOMORROW }).click();
  caught = await waitFor(B, st => st.market === TOMORROW && st.live.length === 1);
  check("and follows", caught !== null, caught === null ? await state(B) : caught + "ms");
}

console.log("\n4b. Going back to an earlier day still shows it");
// A stale cursor would make a revisited day come back empty.
await openSettings(B);
await B.page.fill('input[type="date"]', TODAY);
await closeSettings(B);
caught = await waitFor(B, st => st.market === TODAY && st.live.length === 1, 12000);
check("today's customer is still there on return", caught !== null,
  caught === null ? await state(B) : caught + "ms");

console.log("\n4c. Days do not bleed into each other");
const rowsFor = async day =>
  (await (await fetch(`${WORKER}/sync?stall=${STALL}&market=${day}&since=0`)).json()).rows;
check("yesterday holds one", (await rowsFor(YESTERDAY)).length === 1, (await rowsFor(YESTERDAY)).length);
check("today holds one", (await rowsFor(TODAY)).length === 1, (await rowsFor(TODAY)).length);
check("tomorrow holds one", (await rowsFor(TOMORROW)).length === 1, (await rowsFor(TOMORROW)).length);
check("each day numbers from 1",
  [YESTERDAY, TODAY, TOMORROW].every(async d => (await rowsFor(d))[0].id === 1));

console.log("\n5. An old day can be put back from a file");
const backup = {
  market: LONG_AGO,
  entries: [
    { id: 1, time: "2:15 PM", engage: "Stopped", amount: "", note: "woman looked at rings", ts: "2026-03-21T21:15:20.136Z" },
    { id: 2, time: "2:31 PM", engage: "Bought", amount: "40", note: "", ts: "2026-03-21T21:31:00.000Z" },
  ],
};
const dir = mkdtempSync(join(tmpdir(), "ngd-"));
const path = join(dir, "restore.json");
writeFileSync(path, JSON.stringify(backup));

await openSettings(A);
await A.page.setInputFiles('input[type="file"]', path);
await A.page.waitForTimeout(500);
await closeSettings(A);
const restored = await waitFor(A, st => st.market === LONG_AGO && st.live.length === 2, 12000);
check("the file is read and the phone moves to that day", restored !== null,
  restored === null ? await state(A) : restored + "ms");
const restoredState = await state(A);
check("both customers came back", restoredState.live.length === 2, restoredState.live.length);
check("and nothing from another day came with them",
  restoredState.live.every(e => (e.createdAt || "").startsWith(LONG_AGO)),
  restoredState.live.map(e => e.createdAt));

const backOnServer = await waitFor(A, () => true, 100) !== null &&
  (await (await fetch(`${WORKER}/sync?stall=${STALL}&market=${LONG_AGO}&since=0`)).json()).rows;
check("and reached the server", backOnServer && backOnServer.length === 2, backOnServer && backOnServer.length);

console.log("\n6. Restoring the same file twice cannot duplicate anything");
await openSettings(A);
await A.page.setInputFiles('input[type="file"]', path);
await A.page.waitForTimeout(2500);
await closeSettings(A);
const after = await state(A);
check("still two customers, not four", after.live.length === 2, after.live.length);
const serverAfter = (await (await fetch(`${WORKER}/sync?stall=${STALL}&market=${LONG_AGO}&since=0`)).json()).rows;
check("and the server still holds two", serverAfter.length === 2, serverAfter.length);

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
