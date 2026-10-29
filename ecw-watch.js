// Live mode for the eCW upload: every 30 minutes during its active hours
// (08:30–17:30 Mon–Fri by default), puts every newly exported PDF into its
// patient's Chart Documents in eCW — or, in check mode, only checks it.
//
//   npm run ecw-watch                 # runs until stopped (Ctrl+C)
//   npm run ecw-watch -- --show       # with a visible browser window
//   npm run ecw-watch -- --once       # one check, then exit (ignores active hours)
//
// Each check looks at EVERY day folder still on disk — from the cutover date
// (ECW_UPLOAD_SIGNED_FROM) or RETENTION_DAYS back, whichever is later, to
// today — and skips encounters state/uploads.json already has. So after a
// weekend, Monday's first check picks up what the exporter caught up on.
// It uploads the exporter's private staging copy (state/staging) when there is
// one, and afterwards moves the uploaded PDF in the Teams folder into
// <day>\Uploaded\ (src/ecw/tidy.js) — so billing sees what's left to do.
// (Without a cutover date — check mode only — it looks at today's exports.)
//
// Settings (.env):
//   ECW_UPLOAD_MODE=check|upload   check (default) changes nothing in eCW
//   ECW_AUTOMATIC_UPLOADS=on       also required for upload
//   ECW_UPLOAD_SIGNED_FROM=yyyy-MM-dd   the cutover agreed with billing; required for upload
//   ECW_WATCH_INTERVAL_MINUTES, ECW_ACTIVE_HOURS, ECW_ACTIVE_DAYS
//   ECW_CHECK_OFFSET_MINUTES (default 10)  checks run on the clock at this
//     offset — every 30 min + 10 → :10 and :40 — so they never start at the
//     same moment as the exporter's :00/:30 checks. (The first check after
//     starting runs straight away.)
//
// It stops logging in after a wrong password / CAPTCHA (until restarted), tries
// an unconfirmed login email at most 3 times a day, and stops uploading after
// an upload it isn't sure about — until a person has checked that chart and
// recorded the answer with `npm run ecw-resolve` (picked up at the next check,
// no restart needed). Everything it prints also goes to
// logs/ecw-watch-yyyy-MM-dd.log — encounter IDs and results only.
//
// The browser stays open all day: every new browser means a new eCW login and
// another email for a person to confirm. It's closed outside active hours, and
// replaced only if it crashed.
import { parseArgs } from "node:util";
import { DateTime } from "luxon";
import { BILLING_ZONE } from "./src/dateWindow.js";
import { describeActiveHours, isActive, nextActiveStart, nextSlot } from "./src/activeHours.js";
import { acquireLock } from "./src/lock.js";
import { logDetails, startFileLogging } from "./src/logger.js";
import { loadUploads } from "./src/uploads.js";
import { encountersToCheck } from "./src/ecw/checkList.js";
import { UncertainUploadError, processEncounter } from "./src/ecw/pipeline.js";
import { describeTidy, tidyUploaded } from "./src/ecw/tidy.js";
import { SignInError, openEcw } from "./src/ecw/session.js";
import {
  ecwActiveHours,
  ecwCheckOffsetMinutes,
  ecwLockFile,
  ecwProfileDir,
  ecwUploadMode,
  ecwUploadSignedFrom,
  ecwWatchIntervalMinutes,
  logDir,
  manifestFile,
  outputDir,
  retentionDays,
  stagingDir,
  uploadsFile,
} from "./src/config.js";

const MAX_ERRORS_IN_A_ROW = 5;
const MAX_EMAIL_TRIES_PER_DAY = 3; // each try sends another login email

const logging = startFileLogging(logDir, "ecw-watch");
const ts = () => DateTime.now().setZone(BILLING_ZONE).toFormat("yyyy-MM-dd HH:mm:ss");
const log = (msg) => console.log(`[${ts()}] ${msg}`);

// Settings that would make it do the wrong thing: refuse to start.
// Exit code 2 tells start-ecw-watch.cmd not to restart it.
const refuse = (message) => {
  console.error(`❌ ${message}`);
  process.exit(2);
};
if (!["check", "upload"].includes(ecwUploadMode)) refuse(`ECW_UPLOAD_MODE must be "check" or "upload" (got "${ecwUploadMode}")`);
const cutover = ecwUploadSignedFrom ? DateTime.fromISO(ecwUploadSignedFrom, { zone: BILLING_ZONE }) : null;
if (cutover && !cutover.isValid) refuse(`ECW_UPLOAD_SIGNED_FROM must be a date like 2026-11-03 (got "${ecwUploadSignedFrom}")`);
if (ecwUploadMode === "upload") {
  if (process.env.ECW_AUTOMATIC_UPLOADS !== "on") refuse("ECW_UPLOAD_MODE=upload also needs ECW_AUTOMATIC_UPLOADS=on");
  if (!cutover) refuse("ECW_UPLOAD_MODE=upload needs ECW_UPLOAD_SIGNED_FROM (the cutover date agreed with billing)");
}

// One eCW run at a time. Exit code 3 tells start-ecw-watch.cmd not to retry.
try {
  acquireLock(ecwLockFile, "ecw-watch");
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(3);
}

const { values: args } = parseArgs({
  options: {
    show: { type: "boolean", default: false },
    once: { type: "boolean", default: false },
    interval: { type: "string" },
    today: { type: "string" }, // testing only: pretend "today" is this date
  },
});
const intervalMs = Number(args.interval ?? ecwWatchIntervalMinutes) * 60_000;
if (!(intervalMs > 0)) refuse("--interval / ECW_WATCH_INTERVAL_MINUTES must be a positive number of minutes");
const offsetMs = ecwCheckOffsetMinutes * 60_000;
if (!(offsetMs >= 0)) refuse("ECW_CHECK_OFFSET_MINUTES must be 0 or a positive number of minutes");

const mode = ecwUploadMode;
const credentials = { username: process.env.ECW_USERNAME, password: process.env.ECW_PASSWORD };
const todayNY = () =>
  args.today ? DateTime.fromISO(args.today, { zone: BILLING_ZONE }) : DateTime.now().setZone(BILLING_ZONE).startOf("day");

const uploads = await loadUploads(uploadsFile);
const checkedThisRun = new Set(); // check mode records nothing, so remember here what's been checked
let session = null;
let stopping = false;
let wake = null;
let blocked = null; // why it has stopped working (until restarted), or null
let blockedFor = null; // the encounter it isn't sure about: resolving it lifts the block
let emailTries = { day: null, count: 0 };

const closeSession = async () => {
  const s = session;
  session = null;
  await s?.context.close().catch(() => {});
};
/** False if the browser has crashed or been closed (then it needs a new one). */
const sessionAlive = async () =>
  Boolean(session) && !session.page.isClosed() && (await session.page.evaluate(() => true).catch(() => false));
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  log(`${signal} received — stopping after the current step...`);
  wake?.();
};
process.on("SIGINT", () => stop("Ctrl+C"));
process.on("SIGTERM", () => stop("SIGTERM"));

/**
 * Signature dates to look at: from the cutover — or RETENTION_DAYS back, if that's
 * later (older day folders are gone) — to today. Without a cutover date (check
 * mode only): today's exports only, rather than opening every chart on disk.
 */
const daysToScan = (today) => {
  if (!cutover) return [today.toFormat("yyyy-MM-dd")];
  const oldestOnDisk = today.minus({ days: retentionDays - 1 });
  const from = cutover > oldestOnDisk ? cutover : oldestOnDisk;
  const days = [];
  for (let d = from; d <= today; d = d.plus({ days: 1 })) days.push(d.toFormat("yyyy-MM-dd"));
  return days;
};

/** One check: every encounter not handled yet, through the eCW sequence. */
const check = async () => {
  if (!(await sessionAlive())) {
    await closeSession();
    session = await openEcw({ profileDir: ecwProfileDir, headless: !args.show });
  }
  const totals = { uploaded: 0, ready: 0, manual: 0, error: 0 };
  let errorsInARow = 0;
  for (const day of daysToScan(todayNY())) {
    const waiting = (await encountersToCheck({ manifestFile, outputDir, stagingDir, day })).filter((i) =>
      mode === "check" ? !checkedThisRun.has(i.encounterId) : uploads.readyToUpload(i.encounterId),
    );
    for (const item of waiting) {
      if (stopping) return totals;
      const { result, reason } = await processEncounter(session.page, item, { mode, uploads, credentials, log });
      totals[result]++;
      log(`   ${item.encounterId} (signed ${day}): ${result}${reason ? ` (${reason})` : ""}`);
      if (mode === "check" && result !== "error") checkedThisRun.add(item.encounterId);
      if (result !== "error") errorsInARow = 0;
      else if (++errorsInARow >= MAX_ERRORS_IN_A_ROW) throw new Error(`${MAX_ERRORS_IN_A_ROW} errors in a row`);
    }
  }
  return totals;
};

const sleep = (ms) =>
  new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, ms);
  });

/** The first grid time at or after `t`. */
const slotFrom = (t) => nextSlot(t.minus({ milliseconds: 1 }), intervalMs, offsetMs);
const firstSlot = slotFrom(DateTime.now().setZone(BILLING_ZONE).startOf("day"));
const slotTimes = [firstSlot, nextSlot(firstSlot, intervalMs, offsetMs)].map((t) => t.toFormat(":mm"));
log(`📤 eCW ${mode} mode, every ${intervalMs / 60_000} min (${slotTimes.join(", ")}…), ${describeActiveHours(ecwActiveHours)} (New York time)`);
log(`   ${cutover ? `Encounters signed on or after ${cutover.toFormat("yyyy-MM-dd")}` : "No cutover date set: today's exports only"}`);
if (mode === "check") log("   Check mode: goes as far as Chart Documents, uploads and records nothing.");
log(`   Log file: ${logging.file()}`);

let lastManualCount = uploads.needsManual().length;
let idle = false;
let exitCode = 0;
let nextDue = DateTime.now(); // the first check runs straight away; after that, on the clock grid
while (!stopping) {
  if (!args.once && !isActive(DateTime.now(), ecwActiveHours)) {
    nextDue = slotFrom(nextActiveStart(DateTime.now(), ecwActiveHours));
    if (!idle) {
      idle = true;
      await closeSession();
      log(`😴 Outside active hours — idle until ${nextDue.setZone(BILLING_ZONE).toFormat("ccc yyyy-MM-dd HH:mm")}`);
    }
    // At most one interval at a time, then look again: a laptop that slept can't make it oversleep.
    await sleep(Math.max(5_000, Math.min(intervalMs, nextDue.toMillis() - Date.now())));
    continue;
  }
  if (!args.once && DateTime.now() < nextDue) {
    await sleep(Math.max(50, Math.min(intervalMs, nextDue.toMillis() - Date.now())));
    continue;
  }
  if (idle) {
    idle = false;
    log("☀️  Active hours started — checking again");
  }

  const todayLabel = todayNY().toFormat("yyyy-MM-dd");
  if (emailTries.day !== todayLabel) emailTries = { day: todayLabel, count: 0 };

  // Pick up what a person recorded with ecw-resolve since the last check.
  let recordError = null;
  await uploads.reload().catch((e) => (recordError = e.message));
  if (!recordError && blockedFor && uploads.status(blockedFor) !== "started") {
    const now = uploads.status(blockedFor) === "uploaded" ? "marked uploaded" : "set to be tried again";
    log(`✅ ${blockedFor} was checked by a person (${now}) — uploading again`);
    blocked = null;
    blockedFor = null;
  }

  if (recordError) {
    log(`⛔ Not checking: ${recordError}`); // never upload from a record it can't read
  } else if (blocked) {
    log(`⛔ Not checking: ${blocked}`);
  } else if (emailTries.count >= MAX_EMAIL_TRIES_PER_DAY) {
    log(`⛔ Not checking today: eCW's login email wasn't confirmed ${MAX_EMAIL_TRIES_PER_DAY} times. Tries again tomorrow, or restart it.`);
  } else {
    try {
      const t = await check();
      const done = Object.entries(t).filter(([, n]) => n).map(([r, n]) => `${n} ${r}`).join(" · ");
      log(`✅ Check done: ${done || "nothing new"}`);
    } catch (e) {
      exitCode = 1;
      const reason = e.message.split("\n")[0];
      if (e instanceof SignInError && /email/i.test(reason)) {
        emailTries.count++;
        log(`📧 ${reason} (${emailTries.count} of ${MAX_EMAIL_TRIES_PER_DAY} today)`);
      } else if (e instanceof SignInError) {
        blocked = `eCW sign-in needs a person: ${reason}. Fix it, then restart (logging in again by itself could lock the account).`;
        log(`⛔ ${blocked}`);
      } else if (e instanceof UncertainUploadError) {
        blocked =
          `not sure encounter ${e.encounterId} uploaded (${reason}). Check that chart, then run ` +
          `"npm run ecw-resolve -- ${e.encounterId} --uploaded" (it's there) or "--retry" (it isn't).`;
        blockedFor = e.encounterId;
        log(`⛔ Stopped uploading — ${blocked}`);
      } else {
        log(`❌ Check failed: ${reason}`);
        logDetails("the failed check", e);
        // Keep a working browser: a new one means a new login (and email). Each
        // encounter starts by reloading eCW's home screen anyway.
        if (!(await sessionAlive())) await closeSession();
      }
    }
    const manual = uploads.needsManual();
    if (mode !== "check" && manual.length !== lastManualCount) {
      log(`🙋 Manual list: ${manual.length} encounter(s) need a person:`);
      for (const m of manual) log(`   ${m.encounterId}: ${m.reason}`);
      lastManualCount = manual.length;
    }
  }
  // Uploaded PDFs → <day>\Uploaded\, staged copies deleted. Also while stopped:
  // an encounter a person marked uploaded is tidied too. Check mode moves nothing.
  if (!recordError && mode !== "check") {
    try {
      const tidied = describeTidy(
        await tidyUploaded({ manifestFile, outputDir, stagingDir, days: daysToScan(todayNY()), uploads }),
      );
      if (tidied) log(tidied);
    } catch (e) {
      log(`⚠️  Couldn't tidy up uploaded PDFs: ${e.message.split("\n")[0]} — tries again next check`);
    }
  }
  if (args.once || stopping) break;

  nextDue = nextSlot(DateTime.now(), intervalMs, offsetMs);
  if (isActive(nextDue, ecwActiveHours)) log(`   next check at ${nextDue.setZone(BILLING_ZONE).toFormat("HH:mm")}`);
}

await closeSession();
log("Stopped.");
process.exit(args.once ? exitCode : 0);
