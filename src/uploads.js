// Remembers what happened to each encounter's upload into eCW, so a note is
// never uploaded twice — even after a crash — and anything a person must
// handle lands on the manual list. Stores encounter IDs, dates, statuses and
// reasons only — no patient names.
//
// Statuses:
//   started   recorded just BEFORE the final upload click. If the next run
//             finds it, we can't know whether eCW got the document, so it
//             goes to the manual list instead of being uploaded again.
//   uploaded  confirmed in eCW (by the program, or by a person: `by: "person"`).
//   manual    a person has to do it (no match, several, mismatch, ...).
//
// Two programs may write this file at once (ecw-watch running, and a person
// running ecw-resolve), so every change re-reads the file first and changes
// only its own entry: neither overwrites the other's change.
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ATTEMPTS = 5;

// Windows refuses to replace a file for a moment while another program is
// reading it (EPERM / EBUSY). Wait a little and try again rather than fail.
const renameRetrying = async (from, to) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code) || attempt >= 10) throw e;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
};

export const loadUploads = async (file) => {
  const read = async () => {
    const empty = { version: 1, uploads: {}, failures: {} };
    try {
      return { ...empty, ...JSON.parse(await fs.readFile(file, "utf8")) };
    } catch (e) {
      // A missing file is normal (first run). A broken one is not: starting
      // fresh would forget what's been uploaded, and upload it all again.
      if (e.code === "ENOENT") return empty;
      throw new Error(`Could not read ${file}: ${e.message}`);
    }
  };
  let data = await read();

  /** Re-reads the file, applies `change` to it, and saves (atomically: never a half-written file). */
  const update = async (change) => {
    data = await read();
    const result = change(data);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await renameRetrying(tmp, file);
    return result;
  };

  const set = (encounterId, entry) =>
    update((d) => {
      d.uploads[encounterId] = { ...entry, at: new Date().toISOString() };
    });

  const status = (encounterId) => data.uploads[encounterId]?.status ?? null;
  const hasGivenUp = (encounterId) =>
    (data.failures[encounterId] ?? 0) >= MAX_ATTEMPTS;

  return {
    status,
    hasGivenUp,
    /** Picks up changes another program made to the file (e.g. ecw-resolve). */
    reload: async () => {
      data = await read();
    },
    /** Only true for an encounter we have never touched in eCW and haven't given up on. */
    readyToUpload: (encounterId) =>
      status(encounterId) === null && !hasGivenUp(encounterId),

    /** Call right BEFORE the final upload click (and wait for it to finish). */
    markStarted: (encounterId, dateOfService) =>
      set(encounterId, { status: "started", dateOfService }),

    /** Call once eCW has confirmed the upload. */
    markUploaded: (encounterId, dateOfService) =>
      update((d) => {
        delete d.failures[encounterId];
        d.uploads[encounterId] = { status: "uploaded", dateOfService, at: new Date().toISOString() };
      }),

    /** An upload that may or may not have worked: stays "started", with why (no patient details). */
    markUncertain: (encounterId, reason) =>
      update((d) => {
        if (d.uploads[encounterId]?.status === "started") d.uploads[encounterId].reason = reason;
      }),

    /** A person has to handle it. `reason` must not contain patient details. */
    markNeedsManual: (encounterId, reason) =>
      set(encounterId, { status: "manual", reason }),

    /** A technical failure BEFORE the upload click (nothing was written to eCW). Returns the count. */
    markFailed: (encounterId) =>
      update((d) => (d.failures[encounterId] = (d.failures[encounterId] ?? 0) + 1)),

    /**
     * A person has looked at an encounter on the manual list:
     *   "uploaded"  it's in the chart (the upload did work, or they uploaded it by hand)
     *   "retry"     it's NOT in the chart: forget it, so the next check tries it again
     * @returns {Promise<string | null>} what its status was before
     */
    resolve: (encounterId, outcome) =>
      update((d) => {
        const before = d.uploads[encounterId];
        delete d.failures[encounterId];
        if (outcome === "uploaded") {
          d.uploads[encounterId] = {
            status: "uploaded",
            dateOfService: before?.dateOfService,
            by: "person",
            at: new Date().toISOString(),
          };
        } else if (outcome === "retry") {
          delete d.uploads[encounterId];
        } else {
          throw new Error(`resolve: unknown outcome "${outcome}"`);
        }
        return before?.status ?? null;
      }),

    /** Everything a person needs to look at, with why. */
    needsManual: () => [
      ...Object.entries(data.uploads)
        .filter(([, u]) => u.status === "manual" || u.status === "started")
        .map(([encounterId, u]) => ({
          encounterId,
          reason:
            u.status === "started"
              ? `upload was interrupted — check the chart, it may already be there${u.reason ? ` (${u.reason})` : ""}`
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
