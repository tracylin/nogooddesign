/**
 * Sync backend for the No Good Design stall app.
 *
 * The problem this exists to solve: the old backend was one Google Sheet
 * document that every phone overwrote wholesale, so whoever wrote last erased
 * the others. Here each entry is its own row, so two phones recording two
 * different customers never touch the same thing.
 *
 *   GET  /sync?stall=<key>&market=<day>&since=<cursor>
 *        -> { cursor, rows }   everything changed since the cursor
 *
 *   POST /sync?stall=<key>&market=<day>&since=<cursor>
 *        body { rows: [entry, ...] }
 *        -> { cursor, rows }   upserts the rows, then returns what changed
 *
 *   GET  /markets?stall=<key>
 *        -> every market day held for this stall, with totals
 *
 *   GET  /export?stall=<key>&market=<day>&format=csv|json
 *        -> that day as a file, for keeping somewhere safe
 *
 * A push and a pull are one round trip. The cursor is a server side counter,
 * not a clock, so it does not care whether the phones agree about the time.
 */

const MAX_ROWS = 500;
// Bound values per statement are capped by D1, and the uid lookup is the only
// place where one statement grows with the size of the push.
const LOOKUP_CHUNK = 50;
const MIN_STALL_KEY = 12; // the stall key is the namespace and the only secret

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

/** The app stores an entry as a flat object. These are the fields the server
 *  needs to reason about; everything else rides along untouched in `body`. */
// Conflicts resolve on the timestamp the device wrote, which is only safe while
// the devices roughly agree about the time. A phone whose clock runs fast would
// otherwise win every conflict forever, silently swallowing the other phone's
// edits, so anything claiming to be from the future is pulled back to now.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function normalise(raw, nowMs) {
  if (!raw || typeof raw !== "object") return null;
  const uid = typeof raw.uid === "string" ? raw.uid.trim() : "";
  if (!uid || uid.length > 128) return null;
  let updatedAt = typeof raw.ts === "string" && raw.ts ? raw.ts : new Date(0).toISOString();
  const claimed = Date.parse(updatedAt);
  // A clamped row is one whose own idea of the time we do not believe. It is
  // still stored, but it is never allowed to undo a deletion: bringing back an
  // entry someone deleted is the worst thing this system can do, and a
  // timestamp we do not trust is not good enough reason to do it.
  const trusted = Number.isFinite(claimed) && claimed <= nowMs + MAX_CLOCK_SKEW_MS;
  if (!trusted) updatedAt = new Date(nowMs).toISOString();
  return {
    uid,
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId.slice(0, 64) : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : updatedAt,
    updatedAt,
    deletedAt: typeof raw.deletedAt === "string" && raw.deletedAt ? raw.deletedAt : null,
    seqHint: Number.isInteger(raw.id) && raw.id > 0 ? raw.id : null,
    // Set only by a restore. The flag says the number this row carries is part
    // of the record and must survive; it is not stored on the row itself.
    keepNumber: raw.keepNumber === true,
    trusted,
    stamps: (raw.fieldTs && typeof raw.fieldTs === "object" && !Array.isArray(raw.fieldTs)) ? raw.fieldTs : {},
    body: (() => { const b = { ...raw, ts: updatedAt }; delete b.keepNumber; return b; })(),
  };
}

// Two people editing one customer are usually editing different things: she
// marks the sale, he writes the note. Keeping only the newer of the two whole
// entries throws one of those away, which is how a recorded sale can vanish
// while nobody does anything wrong. So each field carries its own timestamp and
// is merged on its own.
const MERGEABLE = [
  "time", "engage", "amount", "amountManual", "payment",
  "items", "soldCatalogIds", "soldItems", "soldItemNames", "note",
];

function stampFor(stamps, field, fallback) {
  const t = stamps && typeof stamps[field] === "string" ? stamps[field] : null;
  return t || fallback;
}

function mergeBodies(stored, storedStamps, storedUpdated, incoming, incomingStamps, incomingUpdated) {
  const body = { ...stored };
  const stamps = {};
  for (const field of MERGEABLE) {
    const mine = stampFor(storedStamps, field, storedUpdated);
    const theirs = stampFor(incomingStamps, field, incomingUpdated);
    if (field in incoming && theirs > mine) {
      body[field] = incoming[field];
      stamps[field] = theirs;
    } else {
      stamps[field] = mine;
    }
  }
  return { body, stamps };
}

// Deletion is its own field, and it wins a tie: if the two sides are the same
// age and one of them is a deletion, the entry stays deleted.
function resolveDeletion(stored, storedStamps, storedUpdated, incoming, incomingStamps, incomingUpdated, trusted) {
  const mine = stampFor(storedStamps, "deletedAt", storedUpdated);
  const theirs = stampFor(incomingStamps, "deletedAt", incomingUpdated);
  const storedDeleted = stored.deletedAt || null;
  const incomingDeleted = incoming.deletedAt || null;
  // A timestamp we had to clamp may never bring a deleted entry back.
  if (!trusted && storedDeleted && !incomingDeleted) return { deletedAt: storedDeleted, stamp: mine };
  if (theirs > mine) return { deletedAt: incomingDeleted, stamp: theirs };
  if (theirs === mine && incomingDeleted && !storedDeleted) return { deletedAt: incomingDeleted, stamp: theirs };
  return { deletedAt: storedDeleted, stamp: mine };
}

/** Rows go back to the app in exactly the shape it stores them, with the
 *  server's display number and deletion state applied on top. */
function toEntry(row) {
  let body = {};
  try { body = JSON.parse(row.body); } catch { body = {}; }
  let stamps = {};
  try { stamps = row.field_ts ? JSON.parse(row.field_ts) : {}; } catch { stamps = {}; }
  return { ...body, uid: row.uid, id: row.seq, deletedAt: row.deleted_at, ts: row.updated_at, fieldTs: stamps };
}

// The tables are created on first use, so a fresh deployment works without
// anyone having to run a migration by hand. Cached per isolate, so this costs
// one extra round trip after a cold start and nothing after that.
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS entries (" +
        " stall TEXT NOT NULL, market TEXT NOT NULL, uid TEXT NOT NULL," +
        " seq INTEGER NOT NULL, device_id TEXT, created_at TEXT," +
        " updated_at TEXT NOT NULL, deleted_at TEXT, rev INTEGER NOT NULL," +
        " body TEXT NOT NULL, field_ts TEXT, PRIMARY KEY (stall, market, uid))"),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_entries_rev ON entries (stall, market, rev)"),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS counters (" +
        " stall TEXT NOT NULL, market TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0," +
        " seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (stall, market))"),
    ])
      // Tables made before per-field merging need the extra column. SQLite has
      // no IF NOT EXISTS for a column, so a second run simply errors and that
      // is fine.
      .then(() => db.prepare("ALTER TABLE entries ADD COLUMN field_ts TEXT").run().catch(() => {}))
      .catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function changesSince(db, stall, market, since) {
  const { results } = await db
    .prepare("SELECT uid, seq, deleted_at, updated_at, rev, body, field_ts FROM entries " +
             "WHERE stall = ? AND market = ? AND rev > ? ORDER BY rev ASC LIMIT 2000")
    .bind(stall, market, since)
    .all();
  const rows = (results || []).map(toEntry);
  const cursor = (results || []).reduce((m, r) => Math.max(m, r.rev), since);
  return { cursor, rows };
}

// Merging has to happen here rather than in SQL, so an entry is read, merged
// and written back. Two requests could interleave between the read and the
// write, so each update is guarded on the revision it was read at and anything
// that loses the race is simply retried against the newer version.
async function applyRows(db, stall, market, incoming, attempt = 0) {

  // D1 refuses a statement with too many bound values, so the lookup is asked
  // in bites. A whole market day arriving at once, which is what a restore is,
  // used to fail here with "too many SQL variables".
  const existing = new Map();
  for (let i = 0; i < incoming.length; i += LOOKUP_CHUNK) {
    const slice = incoming.slice(i, i + LOOKUP_CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const { results } = await db
      .prepare("SELECT uid, seq, rev, updated_at, deleted_at, body, field_ts FROM entries " +
               `WHERE stall = ? AND market = ? AND uid IN (${placeholders})`)
      .bind(stall, market, ...slice.map(r => r.uid))
      .all();
    (results || []).forEach(row => {
      let body = {}, stamps = {};
      try { body = JSON.parse(row.body); } catch { body = {}; }
      try { stamps = row.field_ts ? JSON.parse(row.field_ts) : {}; } catch { stamps = {}; }
      existing.set(row.uid, { ...row, parsed: body, stamps });
    });
  }

  const fresh = incoming.filter(r => !existing.has(r.uid));

  // A restore brings back a day that already had customer numbers, and those
  // numbers are part of the record: the note in the shop's spreadsheet says
  // customer 84, so after a restore it has to still be customer 84. Ordinary
  // syncing never trusts the number a phone offers, because two phones offline
  // at the same time both believe their next customer is number 12.
  const keep = new Map();
  incoming.forEach(r => { if (r.keepNumber && r.seqHint !== null) keep.set(r.uid, r.seqHint); });
  const counted = fresh.filter(r => !keep.has(r.uid)).length;
  const highest = keep.size ? Math.max(...keep.values()) : 0;

  // Reserve a block of revisions and display numbers in one statement, so two
  // phones pushing at the same moment cannot be handed the same values. The
  // counter is also pulled up past any number a restore brought back, so a
  // customer arriving afterwards cannot be handed one of them a second time.
  await db.prepare("INSERT OR IGNORE INTO counters (stall, market) VALUES (?, ?)")
          .bind(stall, market).run();
  const reserved = await db
    .prepare("UPDATE counters SET rev = rev + ?, seq = MAX(seq, ?) + ? WHERE stall = ? AND market = ? " +
             "RETURNING rev, seq")
    .bind(incoming.length, highest, counted, stall, market)
    .first();

  let rev = reserved.rev - incoming.length;
  let seq = reserved.seq - counted;

  const statements = incoming.map(r => {
    rev += 1;
    const cur = existing.get(r.uid);

    if (!cur) {
      let number;
      if (keep.has(r.uid)) number = keep.get(r.uid);
      else { seq += 1; number = seq; }
      const stamps = {};
      MERGEABLE.forEach(f => { stamps[f] = stampFor(r.stamps, f, r.updatedAt); });
      stamps.deletedAt = stampFor(r.stamps, "deletedAt", r.updatedAt);
      return db.prepare(
        "INSERT INTO entries (stall, market, uid, seq, device_id, created_at, updated_at, deleted_at, rev, body, field_ts) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stall, market, uid) DO NOTHING")
        .bind(stall, market, r.uid, number, r.deviceId, r.createdAt, r.updatedAt, r.deletedAt, rev,
              JSON.stringify(r.body), JSON.stringify(stamps));
    }

    const merged = mergeBodies(cur.parsed, cur.stamps, cur.updated_at, r.body, r.stamps, r.updatedAt);
    const deletion = resolveDeletion(
      { ...cur.parsed, deletedAt: cur.deleted_at }, cur.stamps, cur.updated_at,
      r.body, r.stamps, r.updatedAt, r.trusted);
    merged.stamps.deletedAt = deletion.stamp;
    const body = { ...merged.body, deletedAt: deletion.deletedAt };
    const updatedAt = cur.updated_at > r.updatedAt ? cur.updated_at : r.updatedAt;

    return db.prepare(
      "UPDATE entries SET device_id = ?, seq = ?, updated_at = ?, deleted_at = ?, rev = ?, body = ?, field_ts = ? " +
      "WHERE stall = ? AND market = ? AND uid = ? AND rev = ?")
      .bind(r.deviceId || cur.device_id, keep.has(r.uid) ? keep.get(r.uid) : cur.seq,
            updatedAt, deletion.deletedAt, rev,
            JSON.stringify(body), JSON.stringify(merged.stamps),
            stall, market, r.uid, cur.rev);
  });

  const results = statements.length ? await db.batch(statements) : [];

  // A statement that changed nothing lost a race with another request. Read the
  // newer version and merge onto that instead.
  const lost = incoming.filter((r, i) => {
    const changes = results[i] && results[i].meta ? results[i].meta.changes : 1;
    return changes === 0;
  });
  if (lost.length && attempt < 3) return applyRows(db, stall, market, lost, attempt + 1);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

const EXPORT_COLUMNS = [
  ["number", e => e.id],
  ["time", e => e.time],
  ["engagement", e => e.engage],
  ["amount", e => e.amount],
  ["payment", e => e.payment],
  ["items sold", e => e.soldItemNames ||
    (Array.isArray(e.soldItems) ? e.soldItems.map(i => i.name).join(", ") : (e.soldCatalogIds || []).join(" "))],
  ["items typed", e => e.items],
  ["note", e => e.note],
  ["phone", e => e.deviceId],
  ["created", e => e.createdAt],
  ["last edited", e => e.ts],
  ["deleted", e => e.deletedAt || ""],
];

async function marketsFor(db, stall) {
  const { results } = await db
    .prepare(
      "SELECT market, " +
      "  COUNT(*) FILTER (WHERE deleted_at IS NULL) AS entries, " +
      "  MAX(updated_at) AS last_activity " +
      "FROM entries WHERE stall = ? GROUP BY market ORDER BY market DESC LIMIT 400")
    .bind(stall)
    .all();
  return results || [];
}

async function rowsFor(db, stall, market, includeDeleted) {
  const { results } = await db
    .prepare(
      "SELECT uid, seq, deleted_at, updated_at, body, field_ts FROM entries " +
      "WHERE stall = ? AND market = ? " +
      (includeDeleted ? "" : "AND deleted_at IS NULL ") +
      "ORDER BY seq ASC")
    .bind(stall, market)
    .all();
  return (results || []).map(toEntry);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "nogooddesign-sync" });
    }
    const stallOnly = (url.searchParams.get("stall") || "").trim();

    // A list of every market day this stall has, so past days can be found
    // without having to remember their dates.
    if (url.pathname === "/markets") {
      if (stallOnly.length < MIN_STALL_KEY) return fail("stall key must be at least 12 characters", 400);
      if (!env.DB) return fail("the D1 database is not bound to this Worker", 500);
      try {
        await ensureSchema(env.DB);
        const markets = await marketsFor(env.DB, stallOnly);
        return json({ ok: true, markets: markets.map(m => ({
          market: m.market, entries: m.entries, lastActivity: m.last_activity,
        })) });
      } catch (e) {
        return fail(e.message || "server error", 500);
      }
    }

    // A day as a file, so there is a copy that does not depend on this service
    // still existing.
    if (url.pathname === "/export") {
      const day = (url.searchParams.get("market") || "").trim();
      const format = (url.searchParams.get("format") || "csv").toLowerCase();
      if (stallOnly.length < MIN_STALL_KEY) return fail("stall key must be at least 12 characters", 400);
      if (!day || day.length > 64) return fail("market is required", 400);
      if (!env.DB) return fail("the D1 database is not bound to this Worker", 500);
      try {
        await ensureSchema(env.DB);
        const includeDeleted = url.searchParams.get("deleted") === "1";
        const rows = await rowsFor(env.DB, stallOnly, day, includeDeleted);
        const stamp = "nogooddesign-" + day;
        if (format === "json") {
          return new Response(JSON.stringify({ market: day, exported: new Date().toISOString(), entries: rows }, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition": 'attachment; filename="' + stamp + '.json"',
              "Cache-Control": "no-store", ...CORS,
            },
          });
        }
        const lines = [EXPORT_COLUMNS.map(c => csvCell(c[0])).join(",")];
        rows.forEach(e => lines.push(EXPORT_COLUMNS.map(c => csvCell(c[1](e))).join(",")));
        // The byte order mark keeps Excel from mangling the Chinese item names.
        return new Response("\ufeff" + lines.join("\r\n") + "\r\n", {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="' + stamp + '.csv"',
            "Cache-Control": "no-store", ...CORS,
          },
        });
      } catch (e) {
        return fail(e.message || "server error", 500);
      }
    }

    if (url.pathname !== "/sync") return fail("not found", 404);

    const stall = (url.searchParams.get("stall") || "").trim();
    const market = (url.searchParams.get("market") || "").trim();
    const since = Number.parseInt(url.searchParams.get("since") || "0", 10);

    if (stall.length < MIN_STALL_KEY) return fail("stall key must be at least 12 characters", 400);
    if (stall.length > 128) return fail("stall key is too long", 400);
    if (!market || market.length > 64) return fail("market is required", 400);
    if (!Number.isFinite(since) || since < 0) return fail("since must be a number", 400);

    if (!env.DB) return fail("the D1 database is not bound to this Worker", 500);

    try {
      await ensureSchema(env.DB);

      if (request.method === "GET") {
        return json({ ok: true, ...(await changesSince(env.DB, stall, market, since)) });
      }

      if (request.method === "POST") {
        let payload;
        try { payload = await request.json(); }
        catch { return fail("body must be JSON"); }

        const now = Date.now();
        const incoming = Array.isArray(payload?.rows)
          ? payload.rows.map(r => normalise(r, now)).filter(Boolean)
          : [];
        if (incoming.length > MAX_ROWS) return fail(`at most ${MAX_ROWS} rows per push`, 413);

        // Two pushes in the same batch for one uid would fight each other inside
        // the transaction, so keep only the newest of each.
        const deduped = [...incoming.reduce((m, r) => {
          const cur = m.get(r.uid);
          if (!cur || r.updatedAt > cur.updatedAt) m.set(r.uid, r);
          return m;
        }, new Map()).values()];

        if (deduped.length) await applyRows(env.DB, stall, market, deduped);
        return json({ ok: true, ...(await changesSince(env.DB, stall, market, since)) });
      }

      return fail("method not allowed", 405);
    } catch (e) {
      return fail(e.message || "server error", 500);
    }
  },
};
