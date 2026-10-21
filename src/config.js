// Settings shared by run.js and watch.js. All can be set in .env:
//   OUTPUT_DIR              where the date folders go (point it at the synced Teams folder)
//   STATE_FILE              record of exported encounter IDs (default: state/exported.json)
//   WATCH_INTERVAL_MINUTES  how often watch mode checks (default: 15)
//   ACTIVE_HOURS / ACTIVE_DAYS  when watch mode checks (default: 07:30-17:00, mon-fri, New York time)
//   GEHRIMED_USERNAME / GEHRIMED_PASSWORD   for automatic login
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { saveSnapshot } from "./gehrimed/snapshot.js";
import { parseActiveHours } from "./activeHours.js";

// Relative paths resolve against this project folder, not wherever the command was run from.
export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outputDir = path.resolve(projectDir, process.env.OUTPUT_DIR || "output");
export const stateFile = path.resolve(projectDir, process.env.STATE_FILE || "state/exported.json");
// Only one export may run at a time (see src/lock.js).
export const lockFile = path.join(path.dirname(stateFile), "export.lock");
// Kept for good next to the state file: daily counts (src/ledger.js) and which
// PDF is which encounter (src/manifest.js). IDs and counts only — no names.
export const ledgerFile = path.join(path.dirname(stateFile), "ledger.json");
export const manifestFile = path.join(path.dirname(stateFile), "manifest.jsonl");
export const debugDir = path.resolve(projectDir, "debug"); // snapshots: structure only, no patient data
export const logDir = path.resolve(projectDir, process.env.LOG_DIR || "logs"); // daily logs: IDs and counts only
export const watchIntervalMinutes = Number(process.env.WATCH_INTERVAL_MINUTES || 15);
// Outside these hours watch mode idles (see src/activeHours.js). "always" + "all" = never idle.
export const activeHours = parseActiveHours(process.env.ACTIVE_HOURS || "07:30-17:00", process.env.ACTIVE_DAYS || "mon-fri");
// Date folders this many days old or older are deleted by watch mode (7 → keep today + 6 days back).
export const retentionDays = Number(process.env.RETENTION_DAYS || 7);
// Exported-ID records are kept longer than the folders, just in case.
export const stateRetentionDays = 30;

/**
 * Password for GEHRIMed's "encrypt the PDF" prompt. Generated fresh, kept only
 * in memory, used once to unlock the download. 20 chars with upper, lower,
 * digit and a symbol to satisfy most password rules.
 */
export const randomPassword = () => {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+=@"];
  const all = sets.join("");
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [...sets.map(pick), ...Array.from({ length: 16 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
};

/** Save a sanitized page outline (no patient data) to debug/ after a failure. */
export const snapshotOnFailure = async (page, error) => {
  try {
    const file = await saveSnapshot(page, debugDir, error.message.split("\n")[0]);
    console.error(`   📸 Page structure snapshot saved: ${file}`);
  } catch (e) {
    console.error(`   (could not save snapshot: ${e.message.split("\n")[0]})`);
  }
};
