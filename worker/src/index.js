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
 * A push and a pull are one round trip. The cursor is a server side counter,
 * not a clock, so it does not care whether the phones agree about the time.
 */

const MAX_ROWS = 500;
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
function normalise(raw) {
  if (!raw || typeof raw !== "object") return null;
  const uid = typeof raw.uid === "string" ? raw.uid.trim() : "";
  if (!uid || uid.length > 128) return null;
  const updatedAt = typeof raw.ts === "string" && raw.ts ? raw.ts : new Date(0).toISOString();
  return {
    uid,
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId.slice(0, 64) : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : updatedAt,
    updatedAt,
    deletedAt: typeof raw.deletedAt === "string" && raw.deletedAt ? raw.deletedAt : null,
    seqHint: Number.isInteger(raw.id) ? raw.id : null,
    body: raw,
  };
}

/** Rows go back to the app in exactly the shape it stores them, with the
 *  server's display number and deletion state applied on top. */
function toEntry(row) {
  let body = {};
  try { body = JSON.parse(row.body); } catch { body = {}; }
  return { ...body, uid: row.uid, id: row.seq, deletedAt: row.deleted_at, ts: row.updated_at };
}

async function changesSince(db, stall, market, since) {
  const { results } = await db
    .prepare("SELECT uid, seq, deleted_at, updated_at, rev, body FROM entries " +
             "WHERE stall = ? AND market = ? AND rev > ? ORDER BY rev ASC LIMIT 2000")
    .bind(stall, market, since)
    .all();
  const rows = (results || []).map(toEntry);
  const cursor = (results || []).reduce((m, r) => Math.max(m, r.rev), since);
  return { cursor, rows };
}

async function applyRows(db, stall, market, incoming) {
  // Which uids are already here? Only genuinely new entries consume a display
  // number, otherwise the numbering would grow gaps on every sync.
  const placeholders = incoming.map(() => "?").join(",");
  const { results: existingRows } = await db
    .prepare(`SELECT uid FROM entries WHERE stall = ? AND market = ? AND uid IN (${placeholders})`)
    .bind(stall, market, ...incoming.map(r => r.uid))
    .all();
  const existing = new Set((existingRows || []).map(r => r.uid));
  const fresh = incoming.filter(r => !existing.has(r.uid));

  // Reserve a block of revisions and display numbers in one statement, so two
  // phones pushing at the same moment cannot be handed the same values.
  await db.prepare("INSERT OR IGNORE INTO counters (stall, market) VALUES (?, ?)")
          .bind(stall, market).run();
  const reserved = await db
    .prepare("UPDATE counters SET rev = rev + ?, seq = seq + ? WHERE stall = ? AND market = ? " +
             "RETURNING rev, seq")
    .bind(incoming.length, fresh.length, stall, market)
    .first();

  let rev = reserved.rev - incoming.length;
  let seq = reserved.seq - fresh.length;

  const statements = incoming.map(r => {
    rev += 1;
    const isNew = !existing.has(r.uid);
    if (isNew) seq += 1;
    return db
      .prepare(
        "INSERT INTO entries (stall, market, uid, seq, device_id, created_at, updated_at, deleted_at, rev, body) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (stall, market, uid) DO UPDATE SET " +
        "  device_id  = excluded.device_id, " +
        "  updated_at = excluded.updated_at, " +
        "  deleted_at = excluded.deleted_at, " +
        "  rev        = excluded.rev, " +
        "  body       = excluded.body " +
        // Last write wins, and a deletion wins a tie. Anything older than what
        // is already stored is ignored rather than overwriting it.
        "WHERE excluded.updated_at > entries.updated_at " +
        "   OR (excluded.updated_at = entries.updated_at " +
        "       AND excluded.deleted_at IS NOT NULL AND entries.deleted_at IS NULL)"
      )
      .bind(stall, market, r.uid, isNew ? seq : (r.seqHint ?? 0), r.deviceId,
            r.createdAt, r.updatedAt, r.deletedAt, rev, JSON.stringify(r.body));
  });

  // batch runs as one transaction, so a partial write cannot leave the table
  // holding half of a phone's push.
  if (statements.length) await db.batch(statements);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "nogooddesign-sync" });
    }
    if (url.pathname !== "/sync") return fail("not found", 404);

    const stall = (url.searchParams.get("stall") || "").trim();
    const market = (url.searchParams.get("market") || "").trim();
    const since = Number.parseInt(url.searchParams.get("since") || "0", 10);

    if (stall.length < MIN_STALL_KEY) return fail("stall key must be at least 12 characters", 400);
    if (stall.length > 128) return fail("stall key is too long", 400);
    if (!market || market.length > 64) return fail("market is required", 400);
    if (!Number.isFinite(since) || since < 0) return fail("since must be a number", 400);

    try {
      if (request.method === "GET") {
        return json({ ok: true, ...(await changesSince(env.DB, stall, market, since)) });
      }

      if (request.method === "POST") {
        let payload;
        try { payload = await request.json(); }
        catch { return fail("body must be JSON"); }

        const incoming = Array.isArray(payload?.rows)
          ? payload.rows.map(normalise).filter(Boolean)
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
