// Keeps a constantly running export from piling up files.
//
//   • Date folders (<OUTPUT_DIR>/yyyy-MM-dd) whose date is RETENTION_DAYS (default 7)
//     or more days before today are deleted. Only folders named exactly like a
//     date are ever touched — nothing else in the output folder.
//   • Debug snapshots older than RETENTION_DAYS are deleted.
//
// Note: if OUTPUT_DIR is a synced Teams/OneDrive folder, deleting here deletes
// it in Teams for everyone (it goes to the SharePoint recycle bin).
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";

const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Deletes date folders older than the retention window.
 * @param outputDir  root output folder
 * @param today      Luxon DateTime (New York) — "today"
 * @param days       keep this many days, including today (7 → today and the 6 days before)
 * @returns {Promise<string[]>} names of the folders deleted
 */
export const deleteOldDayFolders = async (outputDir, today, days) => {
  const cutoff = today.startOf("day").minus({ days }); // folders on or before this date go
  const entries = await fs
    .readdir(outputDir, { withFileTypes: true })
    .catch(() => []);
  const deleted = [];
  for (const e of entries) {
    if (!e.isDirectory() || !DATE_FOLDER.test(e.name)) continue;
    const date = DateTime.fromISO(e.name, { zone: today.zone });
    if (!date.isValid || date > cutoff) continue;
    await fs.rm(path.join(outputDir, e.name), { recursive: true, force: true });
    deleted.push(e.name);
  }
  return deleted.sort();
};

/**
 * Deletes temporary folders this tool (or Playwright) left in the system temp
 * folder — e.g. after a crash mid-download. They can hold decrypted patient
 * PDFs, so they shouldn't linger. Only folders whose names start with our own
 * prefixes and that are older than `maxAgeHours` are touched.
 * @returns {Promise<number>} how many were removed
 */
export const deleteStaleTempFolders = async (
  tmpDir,
  maxAgeHours = 6,
  now = Date.now(),
) => {
  const PREFIXES = ["gehrimed-export-", "playwright-artifacts-"];
  const entries = await fs
    .readdir(tmpDir, { withFileTypes: true })
    .catch(() => []);
  let count = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !PREFIXES.some((p) => e.name.startsWith(p)))
      continue;
    const dir = path.join(tmpDir, e.name);
    const { mtimeMs } = await fs.stat(dir).catch(() => ({ mtimeMs: now }));
    if (now - mtimeMs < maxAgeHours * 60 * 60_000) continue; // may be in use right now
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    count++;
  }
  return count;
};

/** Deletes files in `dir` last modified more than `days` days ago. Returns how many. */
export const deleteOldFiles = async (dir, days, now = Date.now()) => {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  let count = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const file = path.join(dir, e.name);
    const { mtimeMs } = await fs.stat(file);
    if (now - mtimeMs >= days * 24 * 60 * 60_000) {
      await fs.rm(file, { force: true });
      count++;
    }
  }
  return count;
};
