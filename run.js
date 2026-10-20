// Export one day's signed GEHRIMed encounter PDFs (catch-up / backfill).
// Watch mode (watch.js) does the same thing every 15 minutes for today.
//
//   npm run export                         # yesterday, first 3 new encounters
//   npm run export -- --limit 0            # yesterday, all new encounters
//   npm run export -- --date 2026-10-13    # a specific signature date
//   npm run export -- --debug              # pause in Playwright Inspector on errors
//
// PDFs go to <OUTPUT_DIR>/<yyyy-MM-dd>/LastNameFirstName_DOBmm.dd.yyyy_DOSmm.dd.yyyy.pdf.
// Encounters already exported (by this or by watch mode) are skipped.
import { parseArgs } from "node:util";
import { DateTime } from "luxon";

import { BILLING_ZONE, getPreviousDayWindow } from "./src/dateWindow.js";
import { openGehrimed } from "./src/gehrimed/session.js";
import { exportSignedOn } from "./src/exporter.js";
import { loadState } from "./src/state.js";
import { ledgerFile, lockFile, manifestFile, outputDir, randomPassword, snapshotOnFailure, stateFile } from "./src/config.js";
import { loadLedger } from "./src/ledger.js";
import { acquireLock } from "./src/lock.js";

const { values: args } = parseArgs({
  options: {
    date: { type: "string" },
    limit: { type: "string", default: "3" },
    headless: { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
  },
});

const day = args.date
  ? DateTime.fromISO(args.date, { zone: BILLING_ZONE })
  : getPreviousDayWindow(DateTime.now()).start;
if (!day.isValid) throw new Error(`Invalid --date "${args.date}" (use YYYY-MM-DD)`);
const limit = Number(args.limit);
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be 0 (all) or a positive number");

// Only one export at a time (watch mode may be running).
try {
  acquireLock(lockFile, "export");
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(3);
}

const state = await loadState(stateFile);
const ledger = await loadLedger(ledgerFile);
let browser;
let activePage = null;
let exitCode = 0;

try {
  const session = await openGehrimed({ headless: args.headless });
  browser = session.browser;
  const { context, page } = session;
  activePage = page;

  console.log(`🔎 Encounters signed on ${day.toFormat("MM/dd/yyyy")}${limit ? ` (up to ${limit} new)` : ""}...`);
  const started = Date.now();
  const c = await exportSignedOn({
    context,
    page,
    day,
    state,
    outputDir,
    password: randomPassword(),
    limit,
    ledger,
    manifestFile,
    onFailure: async (e) => {
      await snapshotOnFailure(page, e);
      if (args.debug) await page.pause();
    },
  });

  const secs = (Date.now() - started) / 1000;
  console.log(`\n📁 ${outputDir}\\${day.toFormat("yyyy-MM-dd")}`);
  console.log(`   Found ${c.found} · already exported ${c.alreadyExported} · saved ${c.saved} · failed ${c.failed}${c.givenUp ? ` · given up ${c.givenUp}` : ""}${c.testPatients ? ` · test patients skipped ${c.testPatients}` : ""}${c.notShown ? ` · NOT on the results page ${c.notShown}` : ""}`);
  if (c.saved) console.log(`   ⏱  ${Math.round(secs)}s total, ${(secs / c.saved).toFixed(1)}s per new encounter`);
  if (c.failed || c.notShown) exitCode = 1;
} catch (e) {
  exitCode = 1;
  if (/has been closed/.test(e.message)) {
    console.error("\n❌ The browser window was closed during the run, so it stopped. (The last '·' step above is where it was.)");
  } else {
    console.error(`\n❌ ${e.message}`);
    if (activePage) await snapshotOnFailure(activePage, e);
  }
} finally {
  await browser?.close().catch(() => {});
}

process.exit(exitCode);
