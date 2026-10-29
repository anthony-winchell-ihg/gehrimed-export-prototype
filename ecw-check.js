// Check mode for the eCW upload — READ-ONLY. For every PDF the export saved
// for one signature date, it finds the patient in eCW by External MRN and
// decides whether it's the right chart (src/ecw/match.js). It uploads
// nothing, opens no chart and changes nothing in eCW.
//
//   npm run ecw-check                                  # yesterday's signature date
//   npm run ecw-check -- --date 2026-10-23
//   npm run ecw-check -- --date 2026-10-23 --limit 3 --show
//
// Writes state/ecw-check-<date>.json: encounter IDs and results only — no
// names, no DOBs. Needs ECW_USERNAME / ECW_PASSWORD in .env; when eCW emails
// its login link, confirm it.
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
  stagingDir,
  stateFile,
} from "./src/config.js";
import { acquireLock } from "./src/lock.js";
import { encountersToCheck } from "./src/ecw/checkList.js";
import { findByExternalMrn } from "./src/ecw/search.js";
import { decideMatch } from "./src/ecw/match.js";
import { SignInError, ensureLoggedIn, openEcw } from "./src/ecw/session.js";

const MAX_ERRORS_IN_A_ROW = 5;
const RESULTS = [
  "match",
  "not-found",
  "several",
  "mismatch",
  "problem",
  "error",
];

const { values: args } = parseArgs({
  options: {
    date: { type: "string" },
    limit: { type: "string", default: "0" },
    show: { type: "boolean", default: false },
  },
});

const day = args.date
  ? DateTime.fromISO(args.date, { zone: BILLING_ZONE })
  : getPreviousDayWindow(DateTime.now()).start;
if (!day.isValid) {
  console.error(`Invalid --date "${args.date}" (use YYYY-MM-DD)`);
  process.exit(2);
}
const dayLabel = day.toFormat("yyyy-MM-dd");
const limit = Number(args.limit);
if (!Number.isInteger(limit) || limit < 0) {
  console.error("--limit must be 0 (all) or a positive number");
  process.exit(2);
}

// One eCW run at a time: two would share (and break) the same browser profile.
try {
  acquireLock(ecwLockFile, "ecw-check");
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(3);
}

const all = await encountersToCheck({ manifestFile, outputDir, stagingDir, day: dayLabel });
const items = limit ? all.slice(0, limit) : all;
console.log(
  `🔎 ${dayLabel}: ${all.length} exported encounter(s)${limit ? `, checking the first ${items.length}` : ""}`,
);

const results = [];
const record = (encounterId, result, reason) => {
  results.push({ encounterId, result, ...(reason && { reason }) });
  console.log(`   ${encounterId}: ${result}${reason ? ` (${reason})` : ""}`);
};

// Problems (missing PDF, renamed file...) need no eCW search.
for (const item of items.filter((i) => i.problem))
  record(item.encounterId, "problem", item.problem);
const toSearch = items.filter((i) => !i.problem);

let exitCode = 0;
if (toSearch.length) {
  const credentials = {
    username: process.env.ECW_USERNAME,
    password: process.env.ECW_PASSWORD,
  };
  const { context, page } = await openEcw({
    profileDir: ecwProfileDir,
    headless: !args.show,
  });
  try {
    await ensureLoggedIn(page, credentials);
    let errorsInARow = 0;
    for (const item of toSearch) {
      try {
        const { result, reason } = decideMatch(
          await findByExternalMrn(page, item.externalMrn),
          item.expected,
        );
        record(item.encounterId, result, reason);
        errorsInARow = 0;
      } catch (e) {
        if (e instanceof SignInError) throw e; // a person must step in: stop everything
        record(item.encounterId, "error", e.message.split("\n")[0]);
        exitCode = 1;
        if (++errorsInARow >= MAX_ERRORS_IN_A_ROW) {
          console.error(`❌ ${MAX_ERRORS_IN_A_ROW} errors in a row — stopping`);
          break;
        }
        await ensureLoggedIn(page, credentials); // a fresh home screen (logs in again if the session ended)
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
  `ecw-check-${dayLabel}.json`,
);
await fs.writeFile(
  reportFile,
  JSON.stringify(
    { day: dayLabel, checkedAt: new Date().toISOString(), summary, results },
    null,
    2,
  ),
);

const line = Object.entries(summary)
  .filter(([, n]) => n)
  .map(([r, n]) => `${n} ${r}`)
  .join(" · ");
console.log(`\n📋 ${line || "nothing to check"}`);
console.log(`   Report: ${reportFile}`);
process.exit(exitCode);
