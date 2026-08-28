# nogooddesign-sync

The sync backend for the stall app. Every entry is its own row, so two phones
recording two different customers never overwrite each other.

Live at `https://nogooddesign.linyijing-t.workers.dev`, deployed from `main`.

## What it does

```
GET  /sync?stall=<key>&market=<day>&since=<cursor>   -> { cursor, rows }
POST /sync?stall=<key>&market=<day>&since=<cursor>   -> { cursor, rows }
     body: { rows: [entry, ...] }

GET  /markets?stall=<key>                            -> every day, with counts
GET  /export?stall=<key>&market=<day>&format=csv     -> that day as a file
GET  /export?stall=<key>&market=<day>&format=json    -> the same, as JSON
GET  /health                                         -> a liveness check
```

A push and a pull are the same round trip: the phone sends the entries it
changed and gets back everything that changed anywhere else since its cursor.

- **`stall`** is the namespace and the only secret. At least 12 characters.
  Anyone holding it can read and write that stall, so treat it like a password
  and keep it out of screenshots.
- **`market`** scopes entries to one day, so a bad day can be cleared without
  touching history and display numbers restart at 1 each market.
- **`since`** is a server side counter, not a clock, so it does not matter
  whether the phones agree about the time.
- Conflicts resolve as last write wins per entry, with a deletion winning a tie.
  Anything older than what is stored is ignored rather than applied.
- A timestamp more than five minutes in the future is pulled back to server
  time, so a phone with a fast clock cannot win every conflict forever. Such a
  row is stored but is **barred from un-deleting an entry**: bringing back a
  deleted customer is the worst thing this system can do, and a timestamp we do
  not trust is not reason enough to do it.
- Deletions are a `deleted_at` column, never a removed row. That is what lets a
  delete on one phone actually reach the other.
- Display numbers are handed out here, so two phones can never show the same
  `#12`.

## Setting it up from scratch

**1. Create the database.** Cloudflare dashboard, **Storage & Databases → D1 SQL
Database → Create**, named `nogooddesign`. Copy the Database ID. You do not need
a domain on the account.

**2. Put the ID in the config.** Replace `database_id` in `wrangler.jsonc`.

**3. Deploy from GitHub.** Dashboard → **Workers & Pages** (some accounts say
**Compute**) → Create → **Import a repository** → `tracylin/nogooddesign`:

| Field | Value |
| --- | --- |
| Path (root directory) | `worker` |
| Build command | *leave empty* |
| Deploy command | `npx wrangler deploy` |

The setup form has no branch selector, so it builds the repository's default
branch. That is why `worker/` lives on `main`.

**4. Check it.** Open the `.workers.dev` URL. You should see
`{"ok":true,"service":"nogooddesign-sync"}`.

There is no migration to run. The tables create themselves on the first request.

**5. Point the app at it.** In the app, gear icon, paste the Worker URL into
**Sync address**. Then **Copy setup link** and open that link on the other
phone, which configures it without any typing.

### From the command line instead

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create nogooddesign     # paste the printed id into wrangler.jsonc
npx wrangler deploy
```

## Backups

Three ways out, so a day's takings never depend on one service still existing.

- **Settings → Save today as CSV.** Built on the phone from what it already has,
  so it works with no signal at all.
- **Settings → Past market days.** Every day held on the server, each with a CSV
  and a JSON download.
- **Settings → Send today to sheet.** The original Google Sheet export.

Both CSV paths write the same columns and lead with a byte order mark, so Excel
does not mangle the Chinese item names.

Export links carry the stall key, so they end up in browser history. That key is
what protects the stall: treat a shared export link the way you would a
password.

### Restoring keeps the customer numbers

Customer numbers are normally the server's to give. A phone only ever suggests
one, because two phones that both went offline at the same moment each believe
their next customer is number 12, and honouring that would hand two different
people the same number.

A restore is the exception. The numbers in a backup are part of the record: the
note in the spreadsheet says customer 84, so after a restore it has to still be
customer 84. Rows in a restore push carry `keepNumber: true` alongside their
`id`, and the server then uses that number, corrects it on a row that is already
here, and pulls its own counter past the highest one it saw so nobody arriving
later is handed it a second time. The flag is not stored on the row.

## Costs

A busy market day is a few hundred writes and a few thousand reads. The free
tier covers 100,000 Worker requests, 100,000 D1 row writes and 5 million D1 row
reads per day.

## Tests

```sh
# terminal 1
cd worker && npm install && npm run dev

# terminal 2
npm run build && npx serve dist -l 5173

# terminal 3
npm test                             # client merge logic, from the repo root
node worker/test/sync.e2e.mjs        # the Worker, driven by simulated phones

npm install --no-save playwright     # the browser runs need this
node worker/test/two-phones.mjs      # two phones, simultaneous adds and deletes
node worker/test/live-sync.mjs       # never reloads, so it catches stalled sync
node worker/test/resilience.mjs      # hung requests, and recovery without restart
node worker/test/offline.mjs         # force close with no signal
```

Pass `SYNC_URL=https://...workers.dev` to run any of these against the deployed
Worker rather than a local one.

Two traps worth knowing, both of which produced tests that passed while
measuring nothing:

- Giving both phones pages in **one** browser context makes them share local
  storage, so one appears to receive what the other merely wrote. Use a context
  per phone, and assert the isolation before anything else.
- Fixture timestamps on a fixed future wall clock get clamped by the skew guard,
  which destroys the ordering under test. Use times relative to now.
