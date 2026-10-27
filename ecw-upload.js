// The eCW upload. For every PDF the export saved for one signature date: find
// the patient by External MRN, check it's the right chart (the search results,
// then the Patient Hub), open Chart Documents and — only in confirm or upload
// mode — add the PDF there as "<date of service> Progress Note".
//
//   npm run ecw-upload -- --date 2026-10-23                                  # check mode: changes nothing
//   npm run ecw-upload -- --date 2026-10-23 --mode confirm --encounter 123   # a person clicks OK for each
//   npm run ecw-upload -- --date 2026-10-23 --mode upload --encounter 123    # needs ECW_AUTOMATIC_UPLOADS=on
//
// Modes:
//   check    goes all the way to Chart Documents; uploads nothing, records nothing
//   confirm  visible browser; for every upload a PERSON clicks OK on eCW's PDF warning
//   upload   automatic — only with ECW_AUTOMATIC_UPLOADS=on in .env, and (for now)
//            only for the encounters named with --encounter
//
// What happened to each encounter is kept in state/uploads.json (src/uploads.js),
// so nothing is ever uploaded twice and anything a person must handle is on the
// manual list. The report (state/ecw-upload-<date>-<mode>.json) and the
// terminal hold encounter IDs and results only — no names, no DOBs.
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { BILLING_ZONE, getPreviousDayWindow } from "./src/dateWindow.js";
import {
  ecwLockFile,
  ecwProfileDir,
  manifestFile,
  outputDir,
  stateFile,
  uploadsFile,
} from "./src/config.js";
import { acquireLock } from "./src/lock.js";
import { loadUploads } from "./src/uploads.js";
import { encountersToCheck } from "./src/ecw/checkList.js";
import { findByExternalMrn } from "./src/ecw/search.js";
import { decideMatch } from "./src/ecw/match.js";
import {
  NeedsPersonError,
  checkHubIdentity,
  openChartDocuments,
  openPatientHub,
} from "./src/ecw/docs.js";
import { uploadToChartDocuments } from "./src/ecw/upload.js";
import { SignInError, ensureLoggedIn, openEcw } from "./src/ecw/session.js";

const MODES = ["check", "confirm", "upload"];
const RESULTS = [
  "uploaded",
  "ready",
  "manual",
  "skipped",
  "error",
  "uncertain",
];
const MAX_ERRORS_IN_A_ROW = 5;

const { values: args } = parseArgs({
  options: {
    date: { type: "string" },
    mode: { type: "string", default: "check" },
    encounter: { type: "string", multiple: true, default: [] },
    show: { type: "boolean", default: false },
  },
});

const refuse = (message) => {
  console.error(`❌ ${message}`);
  process.exit(2);
};

const day = args.date
  ? DateTime.fromISO(args.date, { zone: BILLING_ZONE })
  : getPreviousDayWindow(DateTime.now()).start;
if (!day.isValid) refuse(`Invalid --date "${args.date}" (use YYYY-MM-DD)`);
const dayLabel = day.toFormat("yyyy-MM-dd");
if (!MODES.includes(args.mode))
  refuse(`--mode must be one of: ${MODES.join(", ")}`);
const writes = args.mode !== "check";
if (args.mode === "upload") {
  if (process.env.ECW_AUTOMATIC_UPLOADS !== "on") {
    refuse(
      "upload mode needs ECW_AUTOMATIC_UPLOADS=on in .env (or use --mode confirm: a person approves each upload)",
    );
  }
  if (!args.encounter.length)
    refuse(
      "upload mode only uploads encounters named with --encounter <id> (for now)",
    );
}

// One eCW run at a time: two would share (and break) the same browser profile.
try {
  acquireLock(ecwLockFile, `ecw-upload (${args.mode})`);
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(3);
}

const uploads = await loadUploads(uploadsFile);
const all = await encountersToCheck({ manifestFile, outputDir, day: dayLabel });
const items = args.encounter.length
  ? all.filter((i) => args.encounter.includes(i.encounterId))
  : all;
console.log(`📤 ${dayLabel}, ${args.mode} mode: ${items.length} encounter(s)`);
for (const id of args.encounter.filter(
  (id) => !all.some((i) => i.encounterId === id),
)) {
  console.log(`   ${id}: not exported for ${dayLabel} — skipped`);
}

const results = [];
const record = (encounterId, result, reason) => {
  results.push({ encounterId, result, ...(reason && { reason }) });
  console.log(`   ${encounterId}: ${result}${reason ? ` (${reason})` : ""}`);
};
/** Puts an encounter on the manual list (only when this mode records anything). */
const needsPerson = async (item, reason) => {
  if (writes) await uploads.markNeedsManual(item.encounterId, reason);
  record(item.encounterId, "manual", reason);
};

// First the ones that need no eCW at all.
const toDo = [];
for (const item of items) {
  if (writes && !uploads.readyToUpload(item.encounterId)) {
    record(
      item.encounterId,
      "skipped",
      `already handled: ${uploads.status(item.encounterId) ?? "gave up after repeated failures"}`,
    );
  } else if (item.problem) {
    await needsPerson(item, item.problem);
  } else {
    toDo.push(item);
  }
}

let exitCode = 0;
if (toDo.length) {
  const credentials = {
    username: process.env.ECW_USERNAME,
    password: process.env.ECW_PASSWORD,
  };
  // Confirm mode needs a window: that's where the person clicks OK.
  const { context, page } = await openEcw({
    profileDir: ecwProfileDir,
    headless: !(args.show || args.mode === "confirm"),
  });
  try {
    let errorsInARow = 0;
    for (const item of toDo) {
      let started = false; // set the moment uploads.json says "started"
      try {
        await ensureLoggedIn(page, credentials); // a fresh home screen for every encounter

        const match = decideMatch(
          await findByExternalMrn(page, item.externalMrn),
          item.expected,
        );
        if (match.result !== "match") {
          await needsPerson(item, `${match.result}: ${match.reason}`);
          continue;
        }
        const hub = await openPatientHub(page);
        await checkHubIdentity(hub, {
          externalMrn: item.externalMrn,
          dateOfBirth: item.expected.dateOfBirth,
        });
        const count = await openChartDocuments(page, hub);

        if (!writes) {
          record(
            item.encounterId,
            "ready",
            `would upload here; Chart Documents has ${count}`,
          );
        } else {
          const outcome = await uploadToChartDocuments(page, {
            pdfPath: item.pdfPath,
            dateOfService: item.dateOfService,
            byPerson: args.mode === "confirm",
            beforeWrite: async () => {
              await uploads.markStarted(item.encounterId, item.dateOfService);
              started = true;
            },
          });
          if (outcome.uploaded) {
            await uploads.markUploaded(item.encounterId, item.dateOfService);
            record(item.encounterId, "uploaded");
          } else {
            await needsPerson(item, outcome.reason);
          }
        }
        errorsInARow = 0;
      } catch (e) {
        if (e instanceof SignInError) throw e; // a person must log in: stop everything
        if (e instanceof NeedsPersonError) {
          await needsPerson(item, e.message);
          continue;
        }
        exitCode = 1;
        const reason = e.message.split("\n")[0];
        if (started) {
          // The record stays "started": it's on the manual list and is never uploaded again by itself.
          record(item.encounterId, "uncertain", reason);
          console.error(
            "❌ Not sure an upload worked — stopping. Check that chart before running again.",
          );
          break;
        }
        if (writes) await uploads.markFailed(item.encounterId); // nothing was written: it may be retried
        record(item.encounterId, "error", reason);
        if (++errorsInARow >= MAX_ERRORS_IN_A_ROW) {
          console.error(`❌ ${MAX_ERRORS_IN_A_ROW} errors in a row — stopping`);
          break;
        }
      }
    }
  } catch (e) {
    console.error(`❌ ${e.message.split("\n")[0]}`);
    exitCode = 1;
  } finally {
    await context.close();
  }
}

const summary = Object.fromEntries(
  RESULTS.map((r) => [r, results.filter((x) => x.result === r).length]),
);
const reportFile = path.join(
  path.dirname(stateFile),
  `ecw-upload-${dayLabel}-${args.mode}.json`,
);
await fs.mkdir(path.dirname(reportFile), { recursive: true });
await fs.writeFile(
  reportFile,
  JSON.stringify(
    {
      day: dayLabel,
      mode: args.mode,
      ranAt: new Date().toISOString(),
      summary,
      results,
    },
    null,
    2,
  ),
);

const line = Object.entries(summary)
  .filter(([, n]) => n)
  .map(([r, n]) => `${n} ${r}`)
  .join(" · ");
console.log(`\n📋 ${line || "nothing to do"}`);
console.log(`   Report: ${reportFile}`);
if (writes) {
  const manual = uploads.needsManual();
  if (manual.length) {
    console.log(`\n🙋 Manual list (${manual.length}):`);
    for (const m of manual) console.log(`   ${m.encounterId}: ${m.reason}`);
  }
}
process.exit(exitCode);
