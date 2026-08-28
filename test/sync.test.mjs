// Tests the pure client-side sync logic in src/App.jsx. The Worker has its own
// end to end suite in worker/test/sync.e2e.mjs.
// Run with: npm test
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "App.jsx"), "utf8");
const block = src.slice(src.indexOf("// \u2500\u2500\u2500 IDENTITY"), src.indexOf("// Read straight into the first render"));

const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const { makeUid, makeStallKey, withIdentity, mergeFromServer, sortEntries, pruneTombstones, todayMarket, cursorKey } =
  new Function(block + "\nreturn { makeUid, makeStallKey, withIdentity, mergeFromServer, sortEntries, pruneTombstones, todayMarket, cursorKey };")();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};
const t = n => new Date(Date.UTC(2026, 7, 28, 14, n)).toISOString();

console.log("\n1. Entry identity");
check("two phones never mint the same uid", makeUid("A") !== makeUid("B"));
check("a uid carries the device that made it", makeUid("phoneA").endsWith("-phoneA"));
const legacyA = withIdentity({ id: 87, note: "old entry", ts: t(2) });
const legacyB = withIdentity({ id: 87, note: "old entry", ts: t(2) });
check("pre-uid entries resolve to the same uid on every phone", legacyA.uid === legacyB.uid, [legacyA.uid, legacyB.uid]);
check("an entry that already has a uid is left alone",
  withIdentity({ uid: "keep-me", id: 3 }).uid === "keep-me");

console.log("\n2. A stall key is long enough to be private");
const key = makeStallKey();
check("at least the 12 characters the server demands", key.length >= 12, key.length);
check("two stalls do not collide", makeStallKey() !== makeStallKey());

console.log("\n3. Merging what the server sends back");
const local = [{ uid: "a", id: 1, note: "mine", ts: t(5), deletedAt: null }];
check("a new entry from another phone is added",
  mergeFromServer(local, [{ uid: "b", id: 2, note: "theirs", ts: t(6), deletedAt: null }]).length === 2);
check("a newer server version wins",
  mergeFromServer(local, [{ uid: "a", id: 1, note: "theirs", ts: t(9), deletedAt: null }])[0].note === "theirs");
check("an unsent local edit is not clobbered by an older server copy",
  mergeFromServer(local, [{ uid: "a", id: 1, note: "stale", ts: t(1), deletedAt: null }])[0].note === "mine");
check("the server always owns the display number",
  mergeFromServer(local, [{ uid: "a", id: 42, note: "stale", ts: t(1), deletedAt: null }])[0].id === 42);
check("a deletion from the other phone lands",
  mergeFromServer(local, [{ uid: "a", id: 1, ts: t(9), deletedAt: t(9) }])[0].deletedAt === t(9));

console.log("\n4. Tombstones do not pile up forever");
const kept = pruneTombstones([
  { uid: "old", ts: t(0), deletedAt: new Date(Date.now() - 9 * 864e5).toISOString() },
  { uid: "recent", ts: t(0), deletedAt: new Date(Date.now() - 3600e3).toISOString() },
  { uid: "alive", ts: t(0), deletedAt: null },
]);
check("a week old tombstone is dropped", !kept.find(e => e.uid === "old"));
check("a recent tombstone is kept so it can still travel", !!kept.find(e => e.uid === "recent"));
check("live entries are untouched", !!kept.find(e => e.uid === "alive"));

console.log("\n5. Ordering and market days");
const ordered = sortEntries([{ uid: "a", createdAt: t(1) }, { uid: "c", createdAt: t(30) }, { uid: "b", createdAt: t(15) }]);
check("newest customer first", ordered.map(e => e.uid).join("") === "cba", ordered.map(e => e.uid));
check("a market day reads as a plain date", /^\d{4}-\d{2}-\d{2}$/.test(todayMarket()), todayMarket());
check("today is today", todayMarket(new Date(2026, 7, 28)) === "2026-08-28");
check("cursors are stored per stall and per day",
  cursorKey("s1", "2026-08-28") !== cursorKey("s1", "2026-09-04"));

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
