// Tests the pure sync logic in src/App.jsx against the two phone scenarios that
// used to lose data. Run with: npm test
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "App.jsx"), "utf8");
const block = src.slice(src.indexOf("// \u2500\u2500\u2500 IDENTITY"), src.indexOf("function enrich("));

const store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const { makeUid, withIdentity, mergeEntries, sortEntries, pruneTombstones } =
  new Function(block + "\nreturn { makeUid, withIdentity, mergeEntries, sortEntries, pruneTombstones };")();

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
};

const A = "phoneA", B = "phoneB";
const t = n => new Date(Date.UTC(2026, 7, 28, 14, n)).toISOString();

console.log("\n1. Two phones both mint entry #12 at the same moment");
const a12 = { uid: makeUid(A), deviceId: A, id: 12, engage: "Bought", amount: "40", note: "hat guy", createdAt: t(10), ts: t(10), deletedAt: null };
const b12 = { uid: makeUid(B), deviceId: B, id: 12, engage: "Asked", amount: "", note: "ring lady", createdAt: t(10), ts: t(10), deletedAt: null };
let merged = mergeEntries([a12], [b12]);
check("both customers survive", merged.length === 2, merged.map(e => e.note));
check("uids are distinct", merged[0].uid !== merged[1].uid);
check("neither note was lost", merged.some(e => e.note === "hat guy") && merged.some(e => e.note === "ring lady"));

console.log("\n2. Phone A deletes an entry, phone B still has it live");
const live = { uid: "u-1", deviceId: A, id: 5, note: "keep me", createdAt: t(1), ts: t(1), deletedAt: null };
const tomb = { ...live, ts: t(5), deletedAt: t(5) };
merged = mergeEntries([tomb], [live]);
check("the deletion wins over the stale live copy", merged[0].deletedAt === t(5));
check("it does not resurrect on the next round", mergeEntries(merged, [live])[0].deletedAt === t(5));
check("it is hidden from the counter", merged.filter(e => !e.deletedAt).length === 0);

console.log("\n3. A genuine edit after a delete still wins");
check("later edit beats earlier tombstone", mergeEntries([tomb], [{ ...live, ts: t(9), note: "changed my mind" }])[0].deletedAt === null);

console.log("\n4. Simultaneous delete and edit: the delete wins the tie");
check("tie goes to the tombstone", mergeEntries([{ ...live, ts: t(5), note: "edited" }], [tomb])[0].deletedAt === t(5));

console.log("\n5. Entries written before uids existed");
const legacyA = withIdentity({ id: 87, note: "old entry", ts: t(2) });
const legacyB = withIdentity({ id: 87, note: "old entry", ts: t(2) });
check("both phones derive the same uid", legacyA.uid === legacyB.uid, [legacyA.uid, legacyB.uid]);
check("the old entry is not duplicated", mergeEntries([legacyA], [legacyB]).length === 1);

console.log("\n6. Display numbers are never reused");
const claim = cur => {
  const stored = parseInt(localStorage.getItem("ngd_seq") || "0", 10) || 0;
  const next = Math.max(stored, cur.reduce((m, e) => Math.max(m, e.id || 0), 0)) + 1;
  localStorage.setItem("ngd_seq", String(next));
  return next;
};
const n4 = claim([{ id: 1 }, { id: 2 }, { id: 3 }]);
const n5 = claim([{ id: 1 }, { id: 2 }]);
check("next number after a delete is 5, not 3", n4 === 4 && n5 === 5, { n4, n5 });

console.log("\n7. Old tombstones are pruned, recent ones are kept");
const kept = pruneTombstones([
  { uid: "x", ts: t(0), deletedAt: new Date(Date.now() - 9 * 864e5).toISOString() },
  { uid: "y", ts: t(0), deletedAt: new Date(Date.now() - 3600e3).toISOString() },
  live,
]);
check("week old tombstone dropped", !kept.find(e => e.uid === "x"));
check("recent tombstone kept", !!kept.find(e => e.uid === "y"));
check("live entry untouched", !!kept.find(e => e.uid === "u-1"));

console.log("\n8. Newest first ordering survives a merge");
const ordered = sortEntries([{ uid: "a", createdAt: t(1) }, { uid: "c", createdAt: t(30) }, { uid: "b", createdAt: t(15) }]);
check("sorted newest first", ordered.map(e => e.uid).join("") === "cba", ordered.map(e => e.uid));

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
