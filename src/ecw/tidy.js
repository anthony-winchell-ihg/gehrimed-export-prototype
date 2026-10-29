// After an encounter is uploaded to eCW — by the program, or marked uploaded
// by a person with ecw-resolve — tidies up after it:
//   • its PDF in the Teams day folder moves into <day>\Uploaded\, so what's
//     left at the top of a day folder is what still needs a person;
//   • its private staging copy (patient data) is deleted.
// Nothing is ever deleted from the Teams folder, and nothing is overwritten:
// a name already taken in Uploaded\ gets _2, _3... A move that fails (e.g. the
// PDF is open in another program, which locks it on Windows) is counted and
// simply tried again next time; it never changes the upload record.
//
// Runs after every check over all the days the check looked at, so a crash
// between "uploaded" and "moved" fixes itself.
import fs from "node:fs/promises";
import path from "node:path";
import { readManifest } from "../manifest.js";
import { unstage } from "../staging.js";
import { hashPdfs } from "./checkList.js";

export const UPLOADED_FOLDER = "Uploaded";

/** Moves `file` into `dir` under the same name, or name_2, name_3... — never over an existing file. */
const moveInto = async (file, dir) => {
  await fs.mkdir(dir, { recursive: true });
  const { name, ext } = path.parse(file);
  for (let n = 1; n < 100; n++) {
    const target = path.join(dir, `${name}${n > 1 ? `_${n}` : ""}${ext}`);
    const taken = await fs.access(target).then(() => true, () => false);
    if (!taken) return fs.rename(file, target);
  }
  throw new Error(`Too many files named ${name}_N${ext} in ${dir}`);
};

/**
 * @param {{ manifestFile: string, outputDir: string, stagingDir?: string, days: string[], uploads: object }} o
 *   days: signature dates (yyyy-MM-dd) to tidy; uploads: from loadUploads()
 * @returns {Promise<{ moved: number, unstaged: number, notMoved: number }>}
 */
export const tidyUploaded = async ({ manifestFile, outputDir, stagingDir, days, uploads }) => {
  const counts = { moved: 0, unstaged: 0, notMoved: 0 };
  const done = (await readManifest(manifestFile)).filter(
    (e) => days.includes(e.signedOn) && uploads.status(e.encounterId) === "uploaded",
  );
  const hashedDays = new Map(); // day → sha256 → file, hashed once per day
  for (const e of done) {
    if (stagingDir && (await unstage(stagingDir, e.sha256))) counts.unstaged++;

    const dayDir = path.join(outputDir, e.signedOn);
    if (!hashedDays.has(e.signedOn)) hashedDays.set(e.signedOn, await hashPdfs(dayDir));
    const file = hashedDays.get(e.signedOn).get(e.sha256);
    if (!file) continue; // already moved — by us, or by billing
    try {
      await moveInto(file, path.join(dayDir, UPLOADED_FOLDER));
      counts.moved++;
    } catch {
      counts.notMoved++; // tried again next time
    }
  }
  return counts;
};

/** "📁 Moved 3 uploaded PDF(s) into Uploaded\ · ..." or "" when there's nothing to say. */
export const describeTidy = ({ moved, notMoved }) =>
  [
    moved && `📁 Moved ${moved} uploaded PDF(s) into ${UPLOADED_FOLDER}\\`,
    notMoved && `⚠️  ${notMoved} uploaded PDF(s) couldn't be moved (open in another program?) — tries again next check`,
  ]
    .filter(Boolean)
    .join(" · ");
