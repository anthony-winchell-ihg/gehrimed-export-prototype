// Which encounters to check (and, later, upload) in eCW for one signature
// date, with what eCW needs to find and verify each patient:
//   from the manifest (state/manifest.jsonl): encounter ID, GEHRIMed patient
//     ID (= eCW External MRN), date of service, and the PDF's sha256;
//   the PDF itself, last name and DOB:
//     1. from the private staging copy (src/staging.js) — the last name
//        exactly as GEHRIMed shows it, and not affected by anything billing
//        does in the Teams folder;
//     2. otherwise (PDFs exported before staging existed) from that PDF's file
//        name in <outputDir>/<day>/.
// The PDF is found by its sha256, not its name, so a renamed or moved file is
// still recognized — or reported as a problem, never guessed.
import fs from "node:fs/promises";
import path from "node:path";
import { readManifest, sha256File } from "../manifest.js";
import { parsePdfName } from "../naming.js";
import { readStaged } from "../staging.js";

/**
 * @param {{ manifestFile: string, outputDir: string, stagingDir?: string, day: string }} o  day: the signature date, yyyy-MM-dd
 * @returns {Promise<Array<
 *   { encounterId: string, externalMrn: string, dateOfService: string, pdfPath: string, sha256: string, expected: { lastName: string, dateOfBirth: import("luxon").DateTime } }
 *   | { encounterId: string, problem: string }
 * >>}
 */
export const encountersToCheck = async ({ manifestFile, outputDir, stagingDir, day }) => {
  const manifest = await readManifest(manifestFile);
  const pdfsPerEncounter = new Map();
  for (const e of manifest) pdfsPerEncounter.set(e.encounterId, (pdfsPerEncounter.get(e.encounterId) ?? 0) + 1);
  const entries = manifest.filter((e) => e.signedOn === day);

  let pdfsByHash = null; // the Teams day folder, hashed only if something isn't staged
  const inDayFolder = async (sha256) =>
    (pdfsByHash ??= await hashPdfs(path.join(outputDir, day))).get(sha256);

  const items = [];
  for (const e of entries) {
    const problem = (reason) => items.push({ encounterId: e.encounterId, problem: reason });

    if (!e.patientId) {
      problem("no GEHRIMed patient ID recorded");
      continue;
    }
    // Uploads are recorded per encounter, so a second PDF would never be uploaded.
    if (pdfsPerEncounter.get(e.encounterId) > 1) {
      problem("the export saved more than one PDF for this encounter");
      continue;
    }

    const staged = stagingDir ? await readStaged(stagingDir, e.sha256) : null;
    if (staged?.problem) {
      problem(staged.problem);
      continue;
    }
    if (staged) {
      if (staged.encounterId !== e.encounterId || staged.dateOfService !== e.dateOfService) {
        problem("the staged copy's details don't match the export record");
        continue;
      }
      items.push({
        encounterId: e.encounterId,
        externalMrn: e.patientId,
        dateOfService: e.dateOfService,
        pdfPath: staged.pdfPath,
        sha256: e.sha256,
        expected: { lastName: staged.lastName, dateOfBirth: staged.dateOfBirth },
      });
      continue;
    }

    const pdfPath = await inDayFolder(e.sha256);
    if (!pdfPath) {
      problem("PDF not found in the day folder (moved, deleted or changed?)");
      continue;
    }
    const parsed = parsePdfName(path.basename(pdfPath));
    if (!parsed) {
      problem("PDF file name not in the expected format (renamed?)");
      continue;
    }
    if (parsed.dateOfService.toISODate() !== e.dateOfService) {
      problem("the file name's date of service doesn't match the export record");
      continue;
    }
    items.push({
      encounterId: e.encounterId,
      externalMrn: e.patientId,
      dateOfService: e.dateOfService,
      pdfPath,
      sha256: e.sha256,
      expected: { lastName: parsed.lastName, dateOfBirth: parsed.dateOfBirth },
    });
  }
  return items;
};

/**
 * sha256 → full path, for every PDF directly in `dir` (not in subfolders).
 * Empty if the folder doesn't exist. A PDF that can't be read right now (locked
 * by another program, or removed meanwhile) is left out rather than failing everything.
 */
export const hashPdfs = async (dir) => {
  const names = await fs
    .readdir(dir)
    .catch((e) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
  const byHash = new Map();
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".pdf"))) {
    const file = path.join(dir, name);
    const hash = await sha256File(file).catch((e) =>
      ["ENOENT", "EBUSY", "EPERM", "EACCES", "EISDIR"].includes(e.code) ? null : Promise.reject(e),
    );
    if (hash) byHash.set(hash, file);
  }
  return byHash;
};
