// Two people, one customer, different fields. She marks the sale while he
// writes the note. Nobody is doing anything wrong, and neither of them should
// lose their work.
//
//   cd worker && npm install && npm run dev          # terminal 1
//   npm run build && npx serve dist -l 5173          # terminal 2
//   npm install --no-save playwright                 # terminal 3
//   node worker/test/partial-edits.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";
const WORKER = process.env.SYNC_URL || "http://127.0.0.1:8787";
const STALL = "partial-" + Math.random().toString(36).slice(2, 10);
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
  page.on("dialog", d => d.accept());
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
  await page.waitForTimeout(900);
  return { ctx, page, deviceId };
}

const entries = p => p.page.evaluate(() =>
  JSON.parse(localStorage.getItem("ngd_entries") || "[]").filter(e => !e.deletedAt));

async function waitFor(p, predicate, budget = 9000) {
  const started = Date.now();
  while (Date.now() - started < budget) {
    if (predicate(await entries(p))) return Date.now() - started;
    await p.page.waitForTimeout(300);
  }
  return null;
}

const open = async (p, id) => {
  await p.page.getByText("#" + id, { exact: false }).first().click();
  await p.page.waitForTimeout(200);
};

const A = await phone("cuixi");
const B = await phone("wei");

console.log("\n1. A customer both phones can see");
await A.page.getByRole("button", { name: "✲" }).click();
await A.page.getByRole("button", { name: "Stopped" }).click();
await A.page.getByRole("button", { name: "done" }).click();
check("phone B picks the customer up", (await waitFor(B, e => e.length === 1)) !== null);
const id = (await entries(A))[0].id;

console.log("\n2. She records the sale while he writes the note");
await open(A, id);
await A.page.getByRole("button", { name: "Bought" }).click();
await A.page.getByRole("spinbutton").fill("45");
await A.page.getByRole("button", { name: "Venmo" }).click();

await open(B, id);
await B.page.getByRole("textbox", { name: "note (optional)" }).fill("red hat guy, wants the other colour");

await A.page.getByRole("button", { name: "done" }).click();
await B.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(2000);
await B.page.waitForTimeout(2000);

const settled = e => e.length === 1 && e[0].engage === "Bought" && e[0].amount === "45" &&
  (e[0].note || "").startsWith("red hat guy");
const onA = await waitFor(A, settled, 12000);
const onB = await waitFor(B, settled, 12000);

const a = (await entries(A))[0], b = (await entries(B))[0];
check("the sale survived on her phone", a.engage === "Bought" && a.amount === "45", { engage: a.engage, amount: a.amount });
check("his note survived on her phone", (a.note || "").startsWith("red hat guy"), a.note);
check("the payment method survived", a.payment === "Venmo", a.payment);
check("the sale survived on his phone", b.engage === "Bought" && b.amount === "45", { engage: b.engage, amount: b.amount });
check("his note survived on his phone", (b.note || "").startsWith("red hat guy"), b.note);
check("both phones agree", JSON.stringify([a.engage, a.amount, a.note]) === JSON.stringify([b.engage, b.amount, b.note]));
check("and it settled on both", onA !== null && onB !== null, { onA, onB });

console.log("\n3. The server holds the merged customer, not one half of it");
const stored = (await (await fetch(`${WORKER}/sync?stall=${STALL}&market=${MARKET}&since=0`)).json()).rows[0];
check("sale on the server", stored.engage === "Bought" && stored.amount === "45", { engage: stored.engage, amount: stored.amount });
check("note on the server", (stored.note || "").startsWith("red hat guy"), stored.note);

console.log("\n4. Editing the same field is still last one wins");
await open(A, id);
await A.page.getByRole("textbox", { name: "note (optional)" }).fill("she typed this last");
await A.page.getByRole("button", { name: "done" }).click();
await A.page.waitForTimeout(2500);
const after = await waitFor(B, e => (e[0].note || "") === "she typed this last", 12000);
check("the later edit to the same field wins", after !== null, after === null ? (await entries(B))[0].note : after + "ms");
check("and the sale is still intact", (await entries(B))[0].amount === "45");

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
