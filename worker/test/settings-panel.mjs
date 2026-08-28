// The settings panel kept growing as features landed until its lower half ran
// off the screen with nothing to scroll. Every control in it has to stay
// reachable on a small phone.
//
//   npm run build && npx serve dist -l 5173
//   npm install --no-save playwright
//   node worker/test/settings-panel.mjs
import { chromium } from "playwright";

const APP = process.env.APP_URL || "http://127.0.0.1:5173/";

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });

// A small phone, because that is where it broke. An iPhone SE is 375 by 667.
for (const [label, viewport] of [["iPhone SE", { width: 375, height: 667 }],
                                 ["iPhone 14", { width: 390, height: 844 }]]) {
  console.log("\n" + label + " (" + viewport.width + "x" + viewport.height + ")");
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("pageerror", e => { console.log("  [page error] " + e.message); fail++; });
  await page.goto(APP);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const gear = [...document.querySelectorAll("button")].find(b => b.querySelector("svg"));
    gear?.click();
  });
  await page.waitForTimeout(300);

  const panel = await page.evaluate(() => {
    const body = [...document.querySelectorAll("div")]
      .find(d => d.scrollHeight > d.clientHeight + 20 && getComputedStyle(d).overflowY === "auto");
    if (!body) return null;
    const r = body.getBoundingClientRect();
    return {
      scrollable: body.scrollHeight > body.clientHeight,
      fitsOnScreen: r.bottom <= window.innerHeight + 1 && r.top >= -1,
      hidden: body.scrollHeight - body.clientHeight,
    };
  });
  check("the panel scrolls rather than running off the screen", panel?.scrollable === true, panel);
  check("it stays inside the window", panel?.fitsOnScreen === true, panel);

  // Everything in it must actually be reachable, not just present in the markup.
  const controls = ["Sync now", "Copy setup link", "Save as CSV", "Save as JSON",
                    "Restore from file", "Show days", "Send today to sheet", "Clear local"];
  const unreachable = [];
  for (const name of controls) {
    const ok = await page.getByRole("button", { name, exact: true }).first()
      .scrollIntoViewIfNeeded().then(() => true).catch(() => false);
    const visible = ok && await page.getByRole("button", { name, exact: true }).first()
      .isVisible().catch(() => false);
    if (!visible) unreachable.push(name);
  }
  check("every control can be scrolled to", unreachable.length === 0, unreachable);

  // The way out must never scroll away.
  await page.evaluate(() => {
    const body = [...document.querySelectorAll("div")]
      .find(d => d.scrollHeight > d.clientHeight + 20 && getComputedStyle(d).overflowY === "auto");
    if (body) body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(250);
  const closeVisible = await page.getByRole("button", { name: "✕" }).first().isVisible().catch(() => false);
  check("the close button stays pinned at the bottom of the list", closeVisible);

  // Nothing may extend past the panel's own edges, at any width. Reported from
  // a phone as the panel wobbling sideways while being scrolled.
  const sideways = await page.evaluate(() => {
    const body = [...document.querySelectorAll("div")]
      .find(d => getComputedStyle(d).overflowY === "auto" && d.scrollHeight > d.clientHeight + 20);
    if (!body) return null;
    const br = body.getBoundingClientRect();
    const spilling = [];
    body.querySelectorAll("*").forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > br.right + 0.5 || r.left < br.left - 0.5) {
        spilling.push(el.tagName + " " + (el.textContent || "").trim().slice(0, 20));
      }
    });
    const style = getComputedStyle(body);
    return {
      panelOverflowX: body.scrollWidth - body.clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      touchAction: style.touchAction,
      overflowX: style.overflowX,
      pageHeld: getComputedStyle(document.body).overflow === "hidden",
      spilling: spilling.slice(0, 5),
    };
  });
  check("nothing spills out sideways", sideways?.spilling.length === 0, sideways?.spilling);
  check("the panel cannot scroll sideways", sideways?.panelOverflowX === 0, sideways?.panelOverflowX);
  check("nor can the page behind it", sideways?.pageOverflowX === 0, sideways?.pageOverflowX);
  check("gestures are limited to vertical", sideways?.touchAction === "pan-y", sideways?.touchAction);
  check("the page behind is held still", sideways?.pageHeld === true, sideways?.pageHeld);

  await page.getByRole("button", { name: "✕" }).first().click();
  await page.waitForTimeout(250);
  const closed = !(await page.getByText("Sync address", { exact: false }).first().isVisible().catch(() => false));
  check("and it closes", closed);

  await ctx.close();
}

await browser.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
