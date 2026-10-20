// Reliability record: one entry per signature date, kept for good (counts
// only — no names, no IDs), so after a few weeks you can show how reliable the
// export has been. Each check overwrites that day's latest numbers and adds to
// its running totals.
//
//   signed        what GEHRIMed's search reported for the day
//   exported      encounters saved so far (this check's new + earlier ones)
//   testPatients  skipped on purpose
//   failed        still failing (will be retried)
//   givenUp       failed 5 times — someone needs to look
//   notShown      reported by the search but not on the results page (never attempted)
//   checks / failedChecks / failedAttempts   running totals
//
// assessDay() turns an entry into ✅ / ⏳ / ⚠️ plus the reasons.
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { BILLING_ZONE } from "./dateWindow.js";

export const loadLedger = async (file) => {
  let data = { version: 1, days: {} };
  try {
    data = { ...data, ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Could not read ${file}: ${e.message}`);
  }

  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file); // atomic, like the state file
  };

  const entry = (day) =>
    (data.days[day] ??= { checks: 0, failedChecks: 0, failedAttempts: 0 });

  return {
    /** Records a check of `day` (yyyy-MM-dd) that ran to the end. */
    record: async (day, c) => {
      const e = entry(day);
      Object.assign(e, {
        signed: c.found,
        exported: c.alreadyExported + c.saved,
        testPatients: c.testPatients,
        failed: c.failed,
        givenUp: c.givenUp,
        notShown: c.notShown,
        lastCheck: new Date().toISOString(),
      });
      e.checks++;
      e.failedAttempts += c.failed;
      await save();
    },
    /** Records a check of `day` that stopped part-way (search failed, 5 failures in a row...). */
    recordFailedCheck: async (day, c) => {
      const e = entry(day);
      e.checks++;
      e.failedChecks++;
      e.failedAttempts += c?.failed ?? 0;
      e.lastCheck = new Date().toISOString();
      await save();
    },
    days: () => data.days,
  };
};

/**
 * @param day    yyyy-MM-dd
 * @param e      the ledger entry for that day
 * @param today  Luxon DateTime (New York) — days before it are expected to be finished
 * @returns {{ status: "ok" | "open" | "check", notes: string[] }}
 */
export const assessDay = (day, e, today) => {
  const notes = [];
  const date = DateTime.fromISO(day, { zone: BILLING_ZONE });
  const finished = date < today.startOf("day");

  if (e.signed === undefined) {
    return { status: "check", notes: ["no check of this day has finished"] };
  }
  const outstanding = e.signed - e.exported - e.testPatients;
  if (e.notShown) notes.push(`${e.notShown} not on the results page (never attempted)`);
  if (e.givenUp) notes.push(`${e.givenUp} given up after 5 tries`);
  if (outstanding > 0 && !e.notShown && !e.givenUp) notes.push(`${outstanding} not exported yet`);
  if (outstanding < 0) notes.push(`${-outstanding} more exported than GEHRIMed now lists (unsigned/moved?)`);
  // Zero notes signed on a weekday is possible (holiday) but is also what a
  // broken search would look like — so it's flagged for a person to confirm.
  if (finished && e.signed === 0 && date.weekday <= 5) notes.push("0 signed on a weekday — holiday, or a search problem?");

  if (notes.length === 0) return { status: "ok", notes };
  // A day still in progress (today) with only retries pending is normal.
  const onlyPending = outstanding > 0 && !e.notShown && !e.givenUp;
  return { status: onlyPending && !finished ? "open" : "check", notes };
};
