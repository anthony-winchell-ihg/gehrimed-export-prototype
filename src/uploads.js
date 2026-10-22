// Remembers what happened to each encounter's upload into eCW, so a note is
// never uploaded twice — even after a crash — and anything a person must
// handle lands on the manual list. Stores encounter IDs, dates, statuses and
// reasons only — no patient names.
//
// Statuses:
//   started   recorded just BEFORE the final upload click. If the next run
//             finds it, we can't know whether eCW got the document, so it
//             goes to the manual list instead of being uploaded again.
//   uploaded  confirmed in eCW.
//   manual    a person has to do it (no match, several, mismatch, ...).
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ATTEMPTS = 5;

export const loadUploads = async (file) => {
  let data = { version: 1, uploads: {}, failures: {} };
  try {
    data = { ...data, ...JSON.parse(await fs.readFile(file, "utf8")) };
  } catch (e) {
    // A missing file is normal (first run). A broken one is not: starting
    // fresh would forget what's been uploaded, and upload it all again.
    if (e.code !== "ENOENT")
      throw new Error(`Could not read ${file}: ${e.message}`);
  }

  const save = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file); // atomic: never leaves a half-written file
  };

  const set = async (encounterId, entry) => {
    data.uploads[encounterId] = { ...entry, at: new Date().toISOString() };
    await save();
  };

  const status = (encounterId) => data.uploads[encounterId]?.status ?? null;
  const hasGivenUp = (encounterId) =>
    (data.failures[encounterId] ?? 0) >= MAX_ATTEMPTS;

  return {
    status,
    hasGivenUp,
    /** Only true for an encounter we have never touched in eCW and haven't given up on. */
    readyToUpload: (encounterId) =>
      status(encounterId) === null && !hasGivenUp(encounterId),

    /** Call right BEFORE the final upload click (and wait for it to finish). */
    markStarted: (encounterId, dateOfService) =>
      set(encounterId, { status: "started", dateOfService }),

    /** Call once eCW has confirmed the upload. */
    markUploaded: async (encounterId, dateOfService) => {
      delete data.failures[encounterId];
      await set(encounterId, { status: "uploaded", dateOfService });
    },

    /** A person has to handle it. `reason` must not contain patient details. */
    markNeedsManual: (encounterId, reason) =>
      set(encounterId, { status: "manual", reason }),

    /** A technical failure BEFORE the upload click (nothing was written to eCW). Returns the count. */
    markFailed: async (encounterId) => {
      data.failures[encounterId] = (data.failures[encounterId] ?? 0) + 1;
      await save();
      return data.failures[encounterId];
    },

    /** Everything a person needs to look at, with why. */
    needsManual: () => [
      ...Object.entries(data.uploads)
        .filter(([, u]) => u.status === "manual" || u.status === "started")
        .map(([encounterId, u]) => ({
          encounterId,
          reason:
            u.status === "started"
              ? "upload was interrupted — check the chart, it may already be there"
              : u.reason,
        })),
      ...Object.keys(data.failures)
        .filter((id) => hasGivenUp(id) && status(id) === null)
        .map((encounterId) => ({
          encounterId,
          reason: `failed ${MAX_ATTEMPTS} times`,
        })),
    ],

    MAX_ATTEMPTS,
  };
};
