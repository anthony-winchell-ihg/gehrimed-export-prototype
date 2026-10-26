// Which encounters to check (and, later, upload) in eCW for one signature
// date, with what eCW needs to find and verify each patient:
//   from the manifest (state/manifest.jsonl): encounter ID, GEHRIMed patient
//     ID (= eCW External MRN), date of service, and the PDF's sha256;
//   from that PDF's file name in <outputDir>/<day>/: last name and DOB.
// The PDF is found by its sha256, not its name, so a renamed or moved file is
// still recognized — or reported as a problem, never guessed.
import fs from "node:fs/promises";
import path from "node:path";
import { readManifest, sha256File } from "../manifest.js";
import { parsePdfName } from "../naming.js";

/**
 * @param {{ manifestFile: string, outputDir: string, day: string }} o  day: the signature date, yyyy-MM-dd
 * @returns {Promise<Array<
 *   { encounterId: string, externalMrn: string, dateOfService: string, pdfPath: string, expected: { lastName: string, dateOfBirth: import("luxon").DateTime } }
 *   | { encounterId: string, problem: string }
 * >>}
 */
export const encountersToCheck = async ({ manifestFile, outputDir, day }) => {
  const entries = (await readManifest(manifestFile)).filter(
    (e) => e.signedOn === day,
  );
  const pdfsByHash = await hashPdfs(path.join(outputDir, day));

  return entries.map((e) => {
    const problem = (reason) => ({
      encounterId: e.encounterId,
      problem: reason,
    });

    if (!e.patientId) return problem("no GEHRIMed patient ID recorded");
    const pdfPath = pdfsByHash.get(e.sha256);
    if (!pdfPath)
      return problem(
        "PDF not found in the day folder (moved, deleted or changed?)",
      );
    const parsed = parsePdfName(path.basename(pdfPath));
    if (!parsed)
      return problem("PDF file name not in the expected format (renamed?)");
    if (parsed.dateOfService.toISODate() !== e.dateOfService) {
      return problem(
        "the file name's date of service doesn't match the export record",
      );
    }

    return {
      encounterId: e.encounterId,
      externalMrn: e.patientId,
      dateOfService: e.dateOfService,
      pdfPath,
      expected: { lastName: parsed.lastName, dateOfBirth: parsed.dateOfBirth },
    };
  });
};

/** sha256 → full path, for every PDF in `dir`. Empty if the folder doesn't exist. */
const hashPdfs = async (dir) => {
  const names = await fs
    .readdir(dir)
    .catch((e) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
  const byHash = new Map();
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".pdf"))) {
    const file = path.join(dir, name);
    byHash.set(await sha256File(file), file);
  }
  return byHash;
};
