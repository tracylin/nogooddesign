/**
 * Drives a running Worker with two simulated phones, reproducing the situations
 * that used to lose data at the stall.
 *
 *   Terminal 1:  cd worker && npm run migrate:local && npm run dev
 *   Terminal 2:  node worker/test/sync.e2e.mjs
 */
const BASE = process.env.SYNC_URL || "http://127.0.0.1:8787";
const STALL = "test-stall-" + Math.random().toString(36).slice(2, 10);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
};

const q = (market, since) =>
  `${BASE}/sync?stall=${encodeURIComponent(STALL)}&market=${encodeURIComponent(market)}&since=${since}`;

async function push(market, since, rows) {
  const res = await fetch(q(market, since), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  return { status: res.status, body: await res.json() };
}
async function pull(market, since) {
  const res = await fetch(q(market, since));
  return { status: res.status, body: await res.json() };
}

// Minutes ago, not a fixed wall clock time. A fixed future time would be
// clamped by the server's skew guard and the ordering under test would be lost.
const T0 = Date.now() - 60 * 60 * 1000;
const at = n => new Date(T0 + n * 60 * 1000).toISOString();
const entry = (uid, device, over = {}) => ({
  uid, deviceId: device, engage: "Stopped", amount: "", items: "", soldCatalogIds: [],
  payment: "", note: uid, createdAt: at(1), ts: at(1), deletedAt: null, ...over,
});

const DAY = "2026-08-28";

console.log("\n1. Two phones push different customers at the same moment");
const aRows = [entry("a1", "A"), entry("a2", "A"), entry("a3", "A")];
const bRows = [entry("b1", "B"), entry("b2", "B"), entry("b3", "B")];
const [ra, rb] = await Promise.all([push(DAY, 0, aRows), push(DAY, 0, bRows)]);
check("both pushes accepted", ra.status === 200 && rb.status === 200, [ra.status, rb.status]);
const all = (await pull(DAY, 0)).body;
check("all six customers survive", all.rows.length === 6, all.rows.map(r => r.uid));
check("nothing from phone A was dropped",
  ["a1", "a2", "a3"].every(u => all.rows.some(r => r.uid === u)));
check("nothing from phone B was dropped",
  ["b1", "b2", "b3"].every(u => all.rows.some(r => r.uid === u)));

console.log("\n2. Display numbers are assigned by the server");
const seqs = all.rows.map(r => r.id).sort((x, y) => x - y);
check("every entry has its own number", new Set(seqs).size === 6, seqs);
check("numbered 1 through 6 with no gaps", seqs.join(",") === "1,2,3,4,5,6", seqs);

console.log("\n3. A deletion on one phone reaches the other");
await push(DAY, 0, [entry("a2", "A", { ts: at(5), deletedAt: at(5) })]);
const afterDelete = (await pull(DAY, 0)).body;
const a2 = afterDelete.rows.find(r => r.uid === "a2");
check("the tombstone is stored", a2 && a2.deletedAt === at(5), a2);
check("the entry is still listed, not vanished", !!a2);
check("the other five are untouched",
  afterDelete.rows.filter(r => !r.deletedAt).length === 5);

console.log("\n4. A stale copy from the other phone cannot resurrect it");
await push(DAY, 0, [entry("a2", "B", { ts: at(1) })]);
const afterStale = (await pull(DAY, 0)).body.rows.find(r => r.uid === "a2");
check("still deleted", afterStale.deletedAt === at(5), afterStale);

console.log("\n5. A genuine later edit still wins");
await push(DAY, 0, [entry("a2", "B", { ts: at(9), note: "changed my mind", deletedAt: null })]);
const afterEdit = (await pull(DAY, 0)).body.rows.find(r => r.uid === "a2");
check("undeleted by the newer edit", afterEdit.deletedAt === null, afterEdit);
check("the newer note is kept", afterEdit.note === "changed my mind");
check("its display number never changed", afterEdit.id === a2.id, [a2.id, afterEdit.id]);

console.log("\n6. The cursor only returns what is new");
const snapshot = await pull(DAY, 0);
const quiet = await pull(DAY, snapshot.body.cursor);
check("nothing changed since the cursor", quiet.body.rows.length === 0, quiet.body.rows);
await push(DAY, 0, [entry("c1", "A", { ts: at(11) })]);
const delta = await pull(DAY, snapshot.body.cursor);
check("only the new customer comes back", delta.body.rows.length === 1 && delta.body.rows[0].uid === "c1",
  delta.body.rows.map(r => r.uid));
check("the cursor moved forward", delta.body.cursor > snapshot.body.cursor);

console.log("\n7. Ten simultaneous pushes from three phones lose nothing");
const burst = [];
for (let i = 0; i < 10; i++) {
  const dev = ["A", "B", "C"][i % 3];
  burst.push(push(DAY, 0, [entry("burst" + i, dev, { ts: at(20 + i) })]));
}
await Promise.all(burst);
const afterBurst = (await pull(DAY, 0)).body;
const burstRows = afterBurst.rows.filter(r => r.uid.startsWith("burst"));
check("all ten arrived", burstRows.length === 10, burstRows.length);
check("all ten have distinct numbers", new Set(burstRows.map(r => r.id)).size === 10,
  burstRows.map(r => r.id).sort((x, y) => x - y));

console.log("\n8. A push and a pull are one round trip");
const combined = await push(DAY, 0, [entry("d1", "A", { ts: at(40) })]);
check("the push response carries the full state",
  combined.body.rows.some(r => r.uid === "d1") && combined.body.rows.length === afterBurst.rows.length + 1,
  combined.body.rows.length);

console.log("\n9. Market days are isolated from each other");
await push("2026-09-04", 0, [entry("next1", "A", { ts: at(50) })]);
const otherDay = (await pull("2026-09-04", 0)).body;
check("the new day has only its own entry", otherDay.rows.length === 1, otherDay.rows.map(r => r.uid));
check("its numbering restarts at 1", otherDay.rows[0].id === 1, otherDay.rows[0].id);
const today = (await pull(DAY, 0)).body;
check("today is unaffected", !today.rows.some(r => r.uid === "next1"));

console.log("\n10. A phone with a badly set clock cannot win forever");
// Conflicts resolve on the timestamp the device wrote. Without a clamp, a phone
// running an hour fast would beat every later edit from the other phone.
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
await push(DAY, 0, [entry("skew1", "fastphone", { ts: FUTURE, note: "from the future" })]);
const stored = (await pull(DAY, 0)).body.rows.find(r => r.uid === "skew1");
check("the future timestamp was pulled back to now", stored.ts < FUTURE, stored.ts);
check("the entry itself is kept", stored.note === "from the future", stored.note);

const soon = new Date(Date.now() + 1000).toISOString();
await push(DAY, 0, [entry("skew1", "goodphone", { ts: soon, note: "a normal later edit" })]);
const after = (await pull(DAY, 0)).body.rows.find(r => r.uid === "skew1");
check("a normal later edit still wins", after.note === "a normal later edit", after.note);

console.log("\n11. A day can be taken away as a file");
const csvRes = await fetch(`${BASE}/export?stall=${encodeURIComponent(STALL)}&market=${DAY}&format=csv`);
const csv = await csvRes.text();
check("the CSV downloads rather than opening in the browser",
  (csvRes.headers.get("content-disposition") || "").includes("attachment"), csvRes.headers.get("content-disposition"));
check("it is named after the market day",
  (csvRes.headers.get("content-disposition") || "").includes(DAY));
check("it starts with a byte order mark so Excel reads the names", csv.charCodeAt(0) === 0xfeff);
check("it has a header row", csv.split("\r\n")[0].includes("number") && csv.includes("engagement"));
const csvRows = csv.trim().split("\r\n").length - 1;
check("every live customer is a row", csvRows > 0, csvRows);
check("deleted customers are left out by default", !csv.includes("a2,"), csvRows);

const jsonRes = await fetch(`${BASE}/export?stall=${encodeURIComponent(STALL)}&market=${DAY}&format=json`);
const jsonBody = await jsonRes.json();
check("JSON export carries the same day", jsonBody.market === DAY, jsonBody.market);
check("and the same number of entries", jsonBody.entries.length === csvRows, [jsonBody.entries.length, csvRows]);

console.log("\n12. Past market days can be found again");
const listed = await (await fetch(`${BASE}/markets?stall=${encodeURIComponent(STALL)}`)).json();
const days = listed.markets.map(m => m.market);
check("both days this run created are listed", days.includes(DAY) && days.includes("2026-09-04"), days);
check("newest day first", days[0] >= days[days.length - 1], days);
check("each day carries a count", listed.markets.every(m => typeof m.entries === "number"), listed.markets[0]);
check("a stranger's key sees nothing of this stall",
  (await (await fetch(`${BASE}/markets?stall=someoneelsekey123`)).json()).markets.length === 0);

console.log("\n13. Bad requests are refused");
const shortKey = await fetch(`${BASE}/sync?stall=short&market=${DAY}&since=0`);
check("a guessable stall key is rejected", shortKey.status === 400, shortKey.status);
const noMarket = await fetch(`${BASE}/sync?stall=${STALL}&since=0`);
check("a missing market is rejected", noMarket.status === 400, noMarket.status);
const badBody = await fetch(q(DAY, 0), { method: "POST", body: "not json" });
check("a malformed body is rejected", badBody.status === 400, badBody.status);
const notFound = await fetch(`${BASE}/nope`);
check("unknown paths are refused", notFound.status === 404, notFound.status);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
