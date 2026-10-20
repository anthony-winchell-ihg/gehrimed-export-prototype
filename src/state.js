// Remembers which encounters have already been exported, so each signed note
// is downloaded once — even if billing moves or deletes the PDF afterwards.
// Stores encounter IDs, dates and counts only — no patient names.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ATTEMPTS = 5;

export const loadState = async (file) => {
  let data = { version: 1, exported: {}, failures: {} };
  try {
    data = { ...data, ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`Could not read ${file}: ${e.message}`);
  }

  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file); // atomic: never leaves a half-written state file
  };

  return {
    isExported: (encounterId) => Boolean(data.exported[encounterId]),
    /** Record a successful export (and save immediately). */
    markExported: async (encounterId, day) => {
      data.exported[encounterId] = { day, at: new Date().toISOString() };
      delete data.failures[encounterId];
      await save();
    },
    /** Record a failed attempt. Returns how many times it has failed. */
    markFailed: async (encounterId) => {
      data.failures[encounterId] = (data.failures[encounterId] ?? 0) + 1;
      await save();
      return data.failures[encounterId];
    },
    /** After MAX_ATTEMPTS failures an encounter is skipped until someone looks at it. */
    hasGivenUp: (encounterId) => (data.failures[encounterId] ?? 0) >= MAX_ATTEMPTS,
    exportedCount: () => Object.keys(data.exported).length,
    /** The last signature date that was fully checked (yyyy-MM-dd), or null. */
    lastCompletedDay: () => data.lastCompletedDay ?? null,
    /** Records that `day` (yyyy-MM-dd) was fully checked without errors. */
    markDayCompleted: async (day) => {
      if (!data.lastCompletedDay || day > data.lastCompletedDay) {
        data.lastCompletedDay = day;
        await save();
      }
    },
    /**
     * Forgets exports from before `cutoffDay` (yyyy-MM-dd) so the file doesn't
     * grow forever. Watch mode only searches today and yesterday, so old IDs
     * are never needed again. Returns how many were removed.
     */
    pruneBefore: async (cutoffDay) => {
      let removed = 0;
      for (const [id, entry] of Object.entries(data.exported)) {
        if (entry.day < cutoffDay) {
          delete data.exported[id];
          removed++;
        }
      }
      if (removed) await save();
      return removed;
    },
    MAX_ATTEMPTS,
  };
};
