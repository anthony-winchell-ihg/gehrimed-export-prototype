// A private copy of each exported PDF for the eCW upload, in state/staging/
// (on this computer only, git-ignored), kept until it has been uploaded:
//
//   <sha256>.pdf    the PDF, byte for byte what went into the Teams folder
//   <sha256>.json   { encounterId, lastName, dateOfBirth, dateOfService } —
//                   the last name exactly as GEHRIMed shows it ("Smith Jr."),
//                   dates as yyyy-MM-dd
//
// So the upload doesn't depend on billing's folder (files moved, renamed or
// edited there) or on reading the name back out of the file name, which loses
// spaces and punctuation.
//
// THIS HOLDS PATIENT DATA. A copy is deleted once its encounter is uploaded
// (src/ecw/tidy.js), and watch mode's cleanup deletes anything older than
// RETENTION_DAYS.
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import { sha256File } from "./manifest.js";

const files = (stagingDir, sha256) => ({
  pdf: path.join(stagingDir, `${sha256}.pdf`),
  json: path.join(stagingDir, `${sha256}.json`),
});

/** Writes the file under a temporary name, then renames it: never a half-written file. */
const writeAtomically = async (file, write) => {
  const tmp = `${file}.tmp`;
  await write(tmp);
  await fs.rename(tmp, file);
};

/**
 * Keeps a copy of `pdf` (whose content hashes to `sha256`) with the patient
 * details the upload checks. The details file is written last, so a copy only
 * counts once it's complete.
 * @param {{ encounterId: string, lastName: string, dateOfBirth: string, dateOfService: string }} details
 */
export const stagePdf = async (stagingDir, pdf, sha256, details) => {
  const { pdf: pdfCopy, json } = files(stagingDir, sha256);
  await fs.mkdir(stagingDir, { recursive: true });
  await writeAtomically(pdfCopy, (tmp) => fs.copyFile(pdf, tmp));
  await writeAtomically(json, (tmp) => fs.writeFile(tmp, JSON.stringify(details), "utf8"));
};

/**
 * The staged copy for `sha256`:
 *   null           nothing (complete) staged — e.g. exported before staging existed
 *   { problem }    staged, but changed or unreadable: a person should look
 *   { pdfPath, encounterId, lastName, dateOfBirth (Luxon), dateOfService }
 */
export const readStaged = async (stagingDir, sha256) => {
  const { pdf, json } = files(stagingDir, sha256);
  let details;
  try {
    details = JSON.parse(await fs.readFile(json, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return { problem: "the staged copy's details can't be read" };
  }
  const actual = await sha256File(pdf).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  if (actual === null) return null;
  if (actual !== sha256) return { problem: "the staged copy of the PDF has changed" };

  const dateOfBirth = DateTime.fromISO(String(details.dateOfBirth ?? ""));
  if (!details.lastName || !dateOfBirth.isValid)
    return { problem: "the staged copy's details are incomplete" };
  return {
    pdfPath: pdf,
    encounterId: details.encounterId,
    lastName: details.lastName,
    dateOfBirth,
    dateOfService: details.dateOfService,
  };
};

/** Deletes the staged copy for `sha256`. Returns true if there was one. */
export const unstage = async (stagingDir, sha256) => {
  const { pdf, json } = files(stagingDir, sha256);
  const existed = await fs.access(pdf).then(() => true, () => false);
  await fs.rm(json, { force: true }); // details first: a half-deleted copy then reads as "nothing staged"
  await fs.rm(pdf, { force: true });
  return existed;
};
