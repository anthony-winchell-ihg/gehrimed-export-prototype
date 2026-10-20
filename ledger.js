// How reliable has the export been? One line per signature date, from
// state/ledger.json (counts only — no names, no IDs; safe to share).
//
//   npm run ledger                 # last 30 days
//   npm run ledger -- --days 90
//
// ✅ every signed note exported (or a test patient)
// ⏳ today, still catching up (retries pending)
// ⚠️  needs a look — the reason is shown
import { parseArgs } from "node:util";
import { DateTime } from "luxon";
import { BILLING_ZONE } from "./src/dateWindow.js";
import { ledgerFile } from "./src/config.js";
import { assessDay, loadLedger } from "./src/ledger.js";

const { values: args } = parseArgs({ options: { days: { type: "string", default: "30" } } });
const today = DateTime.now().setZone(BILLING_ZONE).startOf("day");
const since = today.minus({ days: Number(args.days) || 30 }).toFormat("yyyy-MM-dd");

const days = (await loadLedger(ledgerFile)).days();
const rows = Object.keys(days).filter((d) => d >= since).sort();
if (!rows.length) {
  console.log(`No days recorded since ${since} (${ledgerFile}).`);
  process.exit(0);
}

const ICON = { ok: "✅", open: "⏳", check: "⚠️ " };
const pad = (v, n) => String(v ?? "-").padStart(n);
console.log("Signature date   Signed  Exported  Test  Failed  GivenUp  Checks  Retries");
const sum = { signed: 0, exported: 0, ok: 0, check: 0, failedAttempts: 0 };
for (const day of rows) {
  const e = days[day];
  const { status, notes } = assessDay(day, e, today);
  const weekday = DateTime.fromISO(day).toFormat("ccc");
  console.log(
    `${ICON[status]} ${day} ${weekday} ${pad(e.signed, 6)} ${pad(e.exported, 9)} ${pad(e.testPatients, 5)} ` +
      `${pad(e.failed, 7)} ${pad(e.givenUp, 8)} ${pad(e.checks, 7)} ${pad(e.failedAttempts, 8)}` +
      (notes.length ? `   ${notes.join("; ")}` : ""),
  );
  sum.signed += e.signed ?? 0;
  sum.exported += e.exported ?? 0;
  sum.failedAttempts += e.failedAttempts;
  if (status === "ok") sum.ok++;
  if (status === "check") sum.check++;
}
console.log(
  `\n${rows.length} day(s): ${sum.ok} complete, ${sum.check} need a look · ` +
    `${sum.exported} of ${sum.signed} signed notes exported · ${sum.failedAttempts} failed attempt(s) (retried)`,
);
console.log("Note: 'Signed' is what GEHRIMed's own search reported — compare it with another source now and then.");
