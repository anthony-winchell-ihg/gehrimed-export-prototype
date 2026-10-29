// Live mode: every 15 minutes, export any newly signed GEHRIMed encounters.
//
//   npm run watch                 # runs until stopped (Ctrl+C)
//   npm run watch -- --show       # with a visible browser window (for debugging)
//   npm run watch -- --once       # one check, then exit
//
// Each check looks at TODAY's and YESTERDAY's signature dates (yesterday
// catches notes signed just before midnight) and saves only encounters not
// exported before, into <OUTPUT_DIR>/<yyyy-MM-dd>/. Needs GEHRIMED_USERNAME and
// GEHRIMED_PASSWORD in .env so it can log back in when GEHRIMed's session expires.
import { parseArgs } from "node:util";
import { DateTime } from "luxon";

import { BILLING_ZONE } from "./src/dateWindow.js";
import { goToDashboard, openGehrimed } from "./src/gehrimed/session.js";
import { exportSignedOn } from "./src/exporter.js";
import { loadState } from "./src/state.js";
import { assessDay, loadLedger } from "./src/ledger.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { deleteOldDayFolders, deleteOldFiles, deleteStaleTempFolders } from "./src/retention.js";
import { acquireLock } from "./src/lock.js";
import { describeActiveHours, isActive, nextActiveStart } from "./src/activeHours.js";
import {
  activeHours,
  outputDir,
  randomPassword,
  snapshotOnFailure,
  stateFile,
  ledgerFile,
  manifestFile,
  stagingDir,
  watchIntervalMinutes,
  retentionDays,
  stateRetentionDays,
  debugDir,
  logDir,
  lockFile,
  projectDir,
} from "./src/config.js";
import { logDetails, startFileLogging } from "./src/logger.js";

// Everything printed below also goes to logs/watch-yyyy-MM-dd.log.
const logging = startFileLogging(logDir, "watch");

// Only one export at a time. Exit code 3 tells start-watch.cmd not to retry.
try {
  acquireLock(lockFile, "watch");
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(3);
}

const { values: args } = parseArgs({
  options: {
    show: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    interval: { type: "string" },
    // Debugging: after each check, if any code file changed since start, exit
    // with code 4 so start-watch.cmd restarts it straight away on the new code.
    "dev-reload": { type: "boolean", default: false },
    today: { type: "string" }, // testing only: pretend "today" is this date
  },
});

const intervalMs = Number(args.interval ?? watchIntervalMinutes) * 60_000;
if (!(intervalMs > 0)) throw new Error("--interval / WATCH_INTERVAL_MINUTES must be a positive number of minutes");
const RESTART_BROWSER_EVERY_MS = 6 * 60 * 60_000; // fresh browser every 6 hours, as a precaution

const ts = () => DateTime.now().setZone(BILLING_ZONE).toFormat("yyyy-MM-dd HH:mm:ss");
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const todayNY = () =>
  args.today ? DateTime.fromISO(args.today, { zone: BILLING_ZONE }) : DateTime.now().setZone(BILLING_ZONE).startOf("day");

const state = await loadState(stateFile);
const ledger = await loadLedger(ledgerFile);
let session = null;
let sessionStartedAt = 0;
let stopping = false;
let wake = null; // resolves the current sleep early when stopping

const closeSession = async () => {
  const s = session;
  session = null;
  await s?.browser.close().catch(() => {});
};

const stop = async (signal) => {
  if (stopping) return;
  stopping = true;
  log(`${signal} received — stopping after the current step...`);
  wake?.();
};
process.on("SIGINT", () => stop("Ctrl+C"));
process.on("SIGTERM", () => stop("SIGTERM"));

const check = async () => {
  // Browser: start one, or refresh the existing one (logs in again if needed).
  if (!session || Date.now() - sessionStartedAt > RESTART_BROWSER_EVERY_MS) {
    await closeSession();
    session = await openGehrimed({ headless: !args.show });
    sessionStartedAt = Date.now();
  } else {
    await goToDashboard(session.page);
  }

  const today = todayNY();
  const days = daysToCheck(today);
  const totals = { saved: 0, failed: 0, found: 0, notShown: 0 };
  for (const [i, day] of days.entries()) {
    if (stopping) break;
    let snapshotTaken = false;
    const c = await exportSignedOn({
      context: session.context,
      page: session.page,
      day,
      state,
      outputDir,
      password: randomPassword(),
      ledger,
      manifestFile,
      stagingDir,
      onFailure: async (e) => {
        if (!snapshotTaken) await snapshotOnFailure(session.page, e); // one snapshot per day per check
        snapshotTaken = true;
      },
    });
    totals.saved += c.saved;
    totals.failed += c.failed;
    totals.found += c.found;
    totals.notShown += c.notShown;
    log(`${day.toFormat("yyyy-MM-dd")}: ${c.found} signed · ${c.alreadyExported} already exported · ${c.saved} new saved` +
      `${c.failed ? ` · ${c.failed} failed (will retry)` : ""}${c.givenUp ? ` · ${c.givenUp} given up after ${state.MAX_ATTEMPTS} tries` : ""}` +
      `${c.testPatients ? ` · ${c.testPatients} test patient(s) skipped` : ""}` +
      `${c.notShown ? ` · ${c.notShown} NOT on the results page` : ""}`);
    const dayLabel = day.toFormat("yyyy-MM-dd");
    const { status, notes } = assessDay(dayLabel, ledger.days()[dayLabel], today);
    if (status === "check") log(`⚠️  ${dayLabel} needs a look: ${notes.join("; ")}`);
    if (i < days.length - 1) await goToDashboard(session.page); // fresh page for the next search
  }
  // Every day before today is now fully checked — unless something failed or
  // couldn't be reached (then those days are checked again next time).
  if (!totals.failed && !totals.notShown && !stopping) await state.markDayCompleted(today.minus({ days: 1 }).toFormat("yyyy-MM-dd"));
  return totals;
};

/**
 * Normally yesterday + today. After downtime (laptop off over a weekend,
 * reboot, crash), every day since the last fully completed check — so nothing
 * signed while it was off is missed. Capped at the retention window: older
 * folders would be deleted again right away (use `npm run export` for those).
 */
const daysToCheck = (today) => {
  const yesterday = today.minus({ days: 1 });
  const oldestAllowed = today.minus({ days: retentionDays - 1 });
  const last = state.lastCompletedDay() ? DateTime.fromISO(state.lastCompletedDay(), { zone: BILLING_ZONE }) : yesterday;
  let from = last < yesterday ? last : yesterday;
  if (from < oldestAllowed) {
    log(`⚠️  Watch mode was not running since ${last.toFormat("yyyy-MM-dd")}. Catching up from ${oldestAllowed.toFormat("yyyy-MM-dd")}; ` +
      `for earlier days run: npm run export -- --date YYYY-MM-DD --limit 0`);
    from = oldestAllowed;
  }
  const days = [];
  for (let d = from; d <= today; d = d.plus({ days: 1 })) days.push(d);
  if (days.length > 2) log(`   Catching up on ${days.length} days (${days[0].toFormat("yyyy-MM-dd")} → today) after downtime`);
  return days;
};

/** Deletes date folders RETENTION_DAYS+ days old, old debug snapshots, and old state entries. */
const cleanUp = async () => {
  const today = todayNY();
  const folders = await deleteOldDayFolders(outputDir, today, retentionDays);
  if (folders.length) log(`🧹 Deleted ${folders.length} old day folder(s): ${folders.join(", ")}`);
  const snaps = await deleteOldFiles(debugDir, retentionDays);
  if (snaps) log(`🧹 Deleted ${snaps} old debug snapshot(s)`);
  const logs = await deleteOldFiles(logDir, retentionDays);
  if (logs) log(`🧹 Deleted ${logs} old log file(s)`);
  // Private copies for the eCW upload (patient data) that were never uploaded — e.g. on the manual list.
  const staged = await deleteOldFiles(stagingDir, retentionDays);
  if (staged) log(`🧹 Deleted ${staged} old staged file(s) (copies kept for the eCW upload)`);
  const temps = await deleteStaleTempFolders(os.tmpdir());
  if (temps) log(`🧹 Deleted ${temps} leftover temp folder(s) (could hold decrypted PDFs from a crash)`);
  await state.pruneBefore(today.minus({ days: stateRetentionDays }).toFormat("yyyy-MM-dd"));
};

log(`👀 Watching GEHRIMed every ${intervalMs / 60_000} min → ${outputDir}`);
log(`   Active hours: ${describeActiveHours(activeHours)} (New York time)${args.once ? " — ignored with --once" : ""}`);
log(`   Keeping ${retentionDays} day(s) of folders; older ones are deleted.`);
log(`   Log file: ${logging.file()}`);
log(`   ${state.exportedCount()} encounter(s) already exported. Stop with Ctrl+C.`);

// --dev-reload: newest modification time of our code files.
const codeFilesNewest = () => {
  const dirs = [path.join(projectDir, "src"), path.join(projectDir, "src", "gehrimed"), path.join(projectDir, "src", "archive")];
  let newest = fs.statSync(path.join(projectDir, "watch.js")).mtimeMs;
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) if (f.endsWith(".js")) newest = Math.max(newest, fs.statSync(path.join(d, f)).mtimeMs);
  }
  return newest;
};
const codeAtStart = args["dev-reload"] ? codeFilesNewest() : 0;
const codeChangedSinceStart = () => codeFilesNewest() > codeAtStart;
if (args["dev-reload"]) log("🛠  Debug mode: restarts automatically when the code changes");

// A failed SIGN-IN must not be retried every 15 minutes: repeated wrong
// passwords would lock the Netsmart/GEHRIMed account. After one, watch mode
// stays running but stops logging in until it's restarted with fixed settings.
const SIGN_IN_PROBLEM = /Netsmart sign-in failed|extra verification|needs GEHRIMED_USERNAME/;
let signInBlocked = false;

const sleep = (ms) =>
  new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, ms);
  });

let consecutiveErrors = 0;
let exitCode = 0;
let idle = false;
while (!stopping) {
  // Outside active hours: close the browser and wait. Sleeps at most one
  // interval at a time and looks again, so a changed clock or a laptop that
  // slept through the night can't make it oversleep.
  if (!args.once && !isActive(DateTime.now(), activeHours)) {
    const resumeAt = nextActiveStart(DateTime.now(), activeHours);
    if (!idle) {
      idle = true;
      await closeSession();
      log(`😴 Outside active hours — idle until ${resumeAt.setZone(BILLING_ZONE).toFormat("ccc yyyy-MM-dd HH:mm")}. Nothing signed meanwhile is missed.`);
    }
    await sleep(Math.max(5_000, Math.min(intervalMs, resumeAt.toMillis() - Date.now())));
    continue;
  }
  if (idle) {
    idle = false;
    log("☀️  Active hours started — checking again");
  }

  const started = Date.now();
  if (signInBlocked) {
    log("⛔ Not checking: the last sign-in failed (see above). Fix GEHRIMED_USERNAME / GEHRIMED_PASSWORD in .env, " +
      "then restart (Task Scheduler: End, then Run). Retrying automatically could lock the account.");
  } else {
    try {
      await cleanUp().catch((e) => log(`⚠️  Cleanup failed: ${e.message}`));
      const t = await check();
      consecutiveErrors = 0;
      if (t.failed) exitCode = 1;
    } catch (e) {
      consecutiveErrors++;
      exitCode = 1;
      if (!stopping) {
        log(`❌ Check failed (${consecutiveErrors} in a row): ${e.message.split("\n")[0]}`);
        logDetails("the failed check", e); // full explanation → log file only
        if (session?.page) await snapshotOnFailure(session.page, e);
        await closeSession(); // start clean next time
        if (SIGN_IN_PROBLEM.test(e.message)) {
          signInBlocked = true;
          log("⛔ Sign-in problem — stopping automatic logins so the account doesn't get locked.");
        } else if (consecutiveErrors >= 3) {
          log("⚠️  3 checks in a row have failed — someone should look at this.");
        }
      }
    }
  }
  if (args.once || stopping) break;
  if (args["dev-reload"] && codeChangedSinceStart()) {
    log("🔁 Code changed — restarting on the new version");
    await closeSession();
    process.exit(4);
  }

  const wait = Math.max(5_000, intervalMs - (Date.now() - started));
  const nextCheck = DateTime.now().plus({ milliseconds: wait });
  if (isActive(nextCheck, activeHours)) log(`   next check at ${nextCheck.setZone(BILLING_ZONE).toFormat("HH:mm")}`);
  await sleep(wait);
}

await closeSession();
log("Stopped.");
process.exit(args.once ? exitCode : 0);
