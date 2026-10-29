# GEHRIMed signed-note export (prototype)

Saves the PDF of every signed GEHRIMed encounter into a folder per signature
date, named the way billing asked:

```
<OUTPUT_DIR>\2026-10-19\SmithJohn_DOB04.09.1931_DOS10.12.2026.pdf
```

It works through the GEHRIMed **web client** (Playwright), because the
Netsmart API isn't available to us yet.

**Everything this produces contains patient data.** Output, state, debug
snapshots and all `.pdf/.zip/.7z/.csv/.xlsx` files are git-ignored.

## Setup (once)

```bash
npm install
npx playwright install chromium
```

Create `.env` (git-ignored):

| Variable | Needed for | Meaning |
|---|---|---|
| `GEHRIMED_USERNAME` | watch mode, `--headless` | Netsmart ID for logging in |
| `GEHRIMED_PASSWORD` | watch mode, `--headless` | its password |
| `OUTPUT_DIR` | optional (default `./output`) | where the date folders go — point at the **synced Teams channel folder** |
| `STATE_FILE` | optional (default `./state/exported.json`) | record of exported encounter IDs |
| `WATCH_INTERVAL_MINUTES` | optional (default `15`) | how often watch mode checks |
| `ACTIVE_HOURS` | optional (default `07:30-17:00`) | when watch mode checks, New York time; `always` = around the clock |
| `ACTIVE_DAYS` | optional (default `mon-fri`) | which days, e.g. `mon-fri`, `mon,wed,fri`, `all` |
| `LOG_DIR` | optional (default `./logs`) | daily log files (`watch-yyyy-MM-dd.log`), kept `RETENTION_DAYS` days |
| `RETENTION_DAYS` | optional (default `7`) | watch mode deletes date folders this many days old or older (only folders named `yyyy-MM-dd`; in a synced Teams folder that deletes them in Teams too) |

Without credentials, the one-off export opens a browser and you log in by hand.

## Live mode

```bash
npm run watch                 # runs until stopped (Ctrl+C)
npm run watch -- --show       # with a visible browser window, for debugging
npm run watch -- --once       # one check, then exit
```

Every 15 minutes: checks **today's and yesterday's** signature dates
(yesterday catches notes signed just before midnight) and saves only
encounters it hasn't exported before.

- **No duplicates:** exported encounter IDs are recorded in `state/exported.json`
  (IDs and dates only — no names). Billing can move or delete files freely; they
  won't be downloaded again. Delete an ID from that file to re-export it.
- **Active hours:** by default it checks 07:30–17:00, Monday–Friday. Outside
  those hours it keeps running but idles (browser closed, no logins). Notes
  signed in the evening or over the weekend are picked up by the first check
  afterwards (see catch-up below). `--once` ignores active hours.
- **Retries:** a failed encounter is retried on the next check; after 5 failures
  it's skipped and reported until someone looks at it.
- **Catch-up after downtime:** it remembers the last fully checked day. After the
  laptop was off (weekend, reboot), the next check covers every day since — up
  to the retention window; older days need `npm run export -- --date …`.
- **Sign-in failures:** after ONE failed Netsmart sign-in it stops logging in
  (repeated wrong passwords would lock the account) and says so every check.
  Fix `.env`, then restart it.
- **One at a time:** a lock (`state\export.lock`) stops a second watch or a
  catch-up run from starting while one is running (exit code 3).
- **Safety check:** before each download it confirms GEHRIMed's download prompt
  is for the same encounter it read from the row — so a file can never be named
  after the wrong patient.
- **Crashes:** `start-watch.cmd` restarts it after 60 seconds. Leftover temp
  folders from a crash (which can hold decrypted PDFs) are deleted.
- **Sessions:** each check reloads GEHRIMed and logs back in if the session
  expired. The browser is restarted every 6 hours.
- **Safe with Teams/OneDrive sync:** each PDF is written under a temporary
  name and renamed when complete, so a half-written file is never synced.
- **Nothing missed silently:** if GEHRIMed reports more results than its
  results page shows (it displays at most 500), the extra ones are counted as
  *not on the results page*, the day is **not** marked complete, and the log
  says the day needs a look. A weekday with 0 signed notes is also flagged —
  it could be a holiday, or a search that quietly broke.

## Reliability record

Every check also updates `state\ledger.json`: one entry per signature date with
how many notes GEHRIMed listed, how many were exported, skipped as test
patients, still failing, given up, or not on the results page — plus how many
checks and failed attempts there were. Counts only (no names, no IDs), never
deleted, so after a few weeks it shows how reliable the export has been.

```bash
npm run ledger                 # last 30 days, one line per day
npm run ledger -- --days 90
```

✅ = every signed note exported · ⏳ = today, retries pending · ⚠️ = needs a look
(the reason is shown). "Signed" is GEHRIMed's own search count, so compare it
with another source now and then.

## Which file is which encounter (for filing in eCW later)

Each saved PDF also gets a line in `state\manifest.jsonl`:

```json
{"encounterId":"…","patientId":"…","dateOfService":"2026-10-12","signedOn":"2026-10-13","sha256":"…","exportedAt":"…"}
```

No file names or patient names. To find which encounter a PDF is, hash it
(`certutil -hashfile <file> SHA256`) and look up the `sha256` — this keeps
working after billing renames or moves the file. Never deleted.

## Filing the PDFs in eCW (ecw-watch)

`start-ecw-watch.cmd` (its own Task Scheduler task) runs `ecw-watch.js`: every
30 minutes, 08:30–17:30 Mon–Fri, it puts each newly exported PDF into the
patient's **Chart Documents** in eCW as "`<date of service>` Progress Note".
It finds the patient by External MRN (= GEHRIMed patient ID) and only uploads
when exactly one chart has that MRN **and** the DOB and last name agree. A
Jr/Sr/II/III/IV suffix on one side only is ignored (eCW keeps suffixes in a
separate field); two different suffixes never match. Results go to
`state\uploads.json` and `logs\ecw-watch-yyyy-MM-dd.log` (IDs only).

Settings (`.env`): `ECW_USERNAME`, `ECW_PASSWORD`, `ECW_UPLOAD_MODE=upload`,
`ECW_AUTOMATIC_UPLOADS=on`, `ECW_UPLOAD_SIGNED_FROM=yyyy-MM-dd` (the cutover
agreed with billing). Without them it runs in check mode and changes nothing.

The browser stays open all day — each new browser means a new eCW login and
another confirmation email — and is closed outside active hours.

**The manual list** — encounters a person must handle (no chart / several
charts / name or DOB differs / PDF missing / an upload it isn't sure about):

```bash
npm run ecw-resolve                              # show the list
npm run ecw-resolve -- 995274872 --uploaded      # checked: it IS in the chart
npm run ecw-resolve -- 995274872 --retry         # checked: it is NOT — try again automatically
```

**"⛔ Stopped uploading — not sure encounter … uploaded":** eCW's Chart
Documents count didn't go up by one, even after opening the folder again. The
log line before it ("What eCW showed: …") lists any eCW dialogs and the upload
requests. Open that patient's Chart Documents, then run `ecw-resolve` with
`--uploaded` or `--retry`. Live mode picks that up at its next check and
carries on — no restart needed.

## Running it all the time (Windows Task Scheduler)

`start-watch.cmd` starts live mode; Task Scheduler runs it at log-on and
restarts it if it stops. Everything it prints also goes to
`logs\watch-yyyy-MM-dd.log` (timestamped, IDs and counts only, kept 7 days).

1. **Task Scheduler → Create Task…** (not "Basic Task").
2. **General:** name `GEHRIMed Signed Notes Export`; *Run only when user is
   logged on* (OneDrive/Teams sync only runs while you're logged on).
3. **Triggers → New:** *At log on*, your user; *Delay task for* 1 minute.
4. **Actions → New:** *Start a program* `C:\Dev\gehrimed-export-prototype\start-watch.cmd`,
   *Start in* `C:\Dev\gehrimed-export-prototype`.
5. **Conditions:** untick *Start the task only if the computer is on AC power*.
6. **Settings:** tick *If the task fails, restart every* 5 minutes, *up to* 999 times;
   untick *Stop the task if it runs longer than*; *If the task is already running*:
   *Do not start a new instance*.
7. Windows **power settings** (plugged in): never sleep.

Check it: `logs\` gets a new line every 15 minutes; Task Scheduler's *Last Run
Result* shows `0x41301` (running).

## One day, on demand (catch-up)

```bash
npm run export -- --date 2026-10-13 --limit 0    # all new encounters signed that day
npm run export -- --date 2026-10-13               # first 3 new (safe test)
npm run export -- --debug                         # pause in Playwright Inspector on errors
```

Uses the same folders and the same record as watch mode, so the two never
duplicate each other.

## How it works

1. Log in: GEHRIMed username → Netsmart Okta sign-in (`auth.netsmartcloud.com`).
2. Search → Advanced Search → Remove All Search Criteria → Encounter →
   Date of Signature → date → Add.
3. Set **Per Page** to 500 (GEHRIMed shows 10 per page by default).
4. For each new row: View ▾ → **Download** (never Print or Resend) → enter a
   random per-run password in GEHRIMed's "encrypt the PDF" prompt → save →
   remove the PDF password (or unpack a 7-Zip/zip download) → save as
   `LastNameFirstName_DOBmm.dd.yyyy_DOSmm.dd.yyyy.pdf` in the day folder. Same patient and
   date of service twice → `_2`.

The terminal shows encounter IDs only, never patient names. On a failure, a
sanitized page outline (structure and button labels only) goes to `debug/`.

## Tests

```bash
npm test
```

Runs against a **fake** GEHRIMed + fake Okta (`test/mock-gehrimed.js`, made-up
data) that mirror the real page structure: login, paging, password prompt,
password-protected PDF and zip downloads, watch mode picking up a newly
signed note, and that **Resend is never clicked**.

## Not done yet

- Addenda (amended notes are not re-sent yet)
- Teams message on new files / alerts when checks keep failing (or a day needs a look)
- More than 500 notes signed in one day: now reported, but not yet exported (would need GEHRIMed's paging)
- Moving it into the billerbob repo; tests in CI
