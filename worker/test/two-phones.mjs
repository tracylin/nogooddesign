// Two real browsers driving the built app against a local Worker. This is the
// situation that used to lose data at the stall: two phones on one market,
// adding and deleting at the same time, with the signal dropping in the middle.
//
//   cd worker && npm install && npm run dev          # terminal 1
//   npm run build && npx serve dist -l 5173          # terminal 2
//   npm install --no-save playwright                 # terminal 3
//   node worker/test/two-phones.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";
const WORKER = process.env.SYNC_URL || "http://127.0.0.1:8787";
const STALL = "e2e-stall-" + Math.random().toString(36).slice(2, 10);
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
  await page.waitForTimeout(600);
  return { ctx, page, deviceId };
}

const add = p => p.page.getByRole("button", { name: "✲" }).click();
const done = p => p.page.getByRole("button", { name: "done" }).click();
const state = p => p.page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("ngd_entries") || "[]");
  return {
    live: raw.filter(e => !e.deletedAt).map(e => ({ uid: e.uid, id: e.id, note: e.note, dev: e.deviceId })),
    tombstones: raw.filter(e => e.deletedAt).map(e => e.uid),
    unsent: JSON.parse(localStorage.getItem("ngd_dirty") || "[]").length,
  };
});
// Reloading forces a sync straight away instead of waiting out the 20s timer.
const sync = async p => { await p.page.reload(); await p.page.waitForTimeout(900); };

const A = await phone("phoneA");
const B = await phone("phoneB");

console.log("\n1. Both phones start empty and connected");
check("phone A has nothing", (await state(A)).live.length === 0);
check("phone B has nothing", (await state(B)).live.length === 0);

console.log("\n2. Phone A logs a customer, phone B sees it");
await add(A);
await A.page.getByRole("button", { name: "Stopped" }).click();
await A.page.getByRole("textbox", { name: "note (optional)" }).fill("hat guy");
await done(A);
await A.page.waitForTimeout(900);
await sync(B);
const b1 = await state(B);
check("the customer reached phone B", b1.live.length === 1, b1.live);
check("with the note intact", b1.live[0]?.note === "hat guy", b1.live[0]);
check("and shows on screen", await B.page.getByText("#" + b1.live[0]?.id, { exact: false }).first().isVisible());

console.log("\n3. Both phones add a customer at the same moment");
await Promise.all([add(A), add(B)]);
await Promise.all([done(A), done(B)]);
await A.page.waitForTimeout(900);
await sync(A); await sync(B); await sync(A);
const a3 = await state(A), b3 = await state(B);
check("phone A ends up with all three", a3.live.length === 3, a3.live);
check("phone B ends up with all three", b3.live.length === 3, b3.live);
check("both phones agree on which three",
  a3.live.map(e => e.uid).sort().join() === b3.live.map(e => e.uid).sort().join());
const ids = a3.live.map(e => e.id).sort((x, y) => x - y);
check("every customer has their own number", new Set(ids).size === 3, ids);
check("numbered from the server with no gaps", ids.join(",") === "1,2,3", ids);

console.log("\n4. A deletion on phone A actually reaches phone B");
const victim = a3.live.find(e => e.dev === "phoneA" && e.note !== "hat guy") || a3.live[0];
await A.page.getByText("#" + victim.id, { exact: false }).first().click();
await A.page.getByRole("button", { name: "delete" }).click();
await A.page.waitForTimeout(900);
await sync(A); await sync(B);
const b4 = await state(B);
check("phone B is down to two customers", b4.live.length === 2, b4.live);
check("the deleted one is gone from B", !b4.live.some(e => e.uid === victim.uid));
check("B holds a tombstone rather than forgetting", b4.tombstones.includes(victim.uid), b4.tombstones);

console.log("\n5. Phone B cannot resurrect it by syncing again");
await sync(B); await sync(A); await sync(B);
const b5 = await state(B), a5 = await state(A);
check("still gone on B", !b5.live.some(e => e.uid === victim.uid), b5.live);
check("still gone on A", !a5.live.some(e => e.uid === victim.uid), a5.live);
check("both phones still agree", a5.live.length === 2 && b5.live.length === 2, [a5.live.length, b5.live.length]);

console.log("\n6. Phone A goes offline mid market");
await A.ctx.setOffline(true);
await add(A);
await A.page.getByRole("button", { name: "Bought" }).click();
await A.page.getByRole("spinbutton").fill("45");
await done(A);
await A.page.waitForTimeout(1200);
const aOff = await state(A);
check("the sale is recorded locally anyway", aOff.live.length === 3, aOff.live);
check("and queued to send", aOff.unsent >= 1, aOff.unsent);
check("the header admits it is offline", await A.page.getByText("offline", { exact: false }).first().isVisible());
await sync(B);
const bOff = await state(B);
check("phone B has not seen it yet", bOff.live.length === 2, bOff.live);

console.log("\n7. Signal comes back");
await A.ctx.setOffline(false);
await A.page.evaluate(() => window.dispatchEvent(new Event("online")));
await A.page.waitForTimeout(1500);
const aBack = await state(A);
check("the queue drained", aBack.unsent === 0, aBack.unsent);
await sync(B);
const bBack = await state(B);
check("the sale reached phone B", bBack.live.length === 3, bBack.live);
check("with the amount intact", await B.page.getByText("$45", { exact: false }).first().isVisible());

console.log("\n8. Nothing was invented or lost overall");
const a8 = await state(A), b8 = await state(B);
check("the two phones hold identical lists",
  JSON.stringify(a8.live.map(e => e.uid).sort()) === JSON.stringify(b8.live.map(e => e.uid).sort()),
  [a8.live.map(e => e.uid), b8.live.map(e => e.uid)]);
check("all display numbers are still distinct",
  new Set(a8.live.map(e => e.id)).size === a8.live.length, a8.live.map(e => e.id));

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
