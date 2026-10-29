// Exports every not-yet-exported encounter signed on one day into
// <outputDir>/<yyyy-MM-dd>/<LastNameFirstName_DOBmm.dd.yyyy_DOSmm.dd.yyyy>.pdf.
// Used by both run.js (one day, on demand) and watch.js (every 15 minutes).
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchSignedOn, showAllResults } from "./gehrimed/search.js";
import {
  downloadEncounter,
  isTestPatient,
  readColumns,
  readRowDetails,
  resultRows,
} from "./gehrimed/download.js";
import { extractPdfs } from "./archive/sevenZip.js";
import { buildPdfName, parseGehrimedDate } from "./naming.js";
import { logDetails } from "./logger.js";
import { appendManifest, sha256File } from "./manifest.js";
import { stagePdf } from "./staging.js";

const MAX_FAILURES_IN_A_ROW = 5;

/**
 * @param {object} o
 * @param o.context, o.page   Playwright context/page (logged in, on the dashboard)
 * @param o.day               Luxon DateTime — the signature date to export
 * @param o.state             from loadState()
 * @param o.outputDir         root folder (e.g. the synced Teams folder)
 * @param o.password          per-run password for GEHRIMed's encryption prompt
 * @param o.limit             max NEW encounters to download (0 = no limit)
 * @param o.onFailure         async (error) => void — e.g. save a debug snapshot
 * @param o.ledger            optional, from loadLedger() — this check's counts are recorded there
 * @param o.manifestFile      optional — one line per saved PDF is appended (see manifest.js)
 * @param o.stagingDir        optional — a private copy of each PDF for the eCW upload (see staging.js)
 * @returns {Promise<{ found, alreadyExported, saved, failed, givenUp, testPatients, notShown }>}
 *   notShown > 0 means GEHRIMed reported more results than its page showed —
 *   those were never attempted, so the day must not count as complete.
 */
export const exportSignedOn = async (o) => {
  const dayLabel = o.day.toFormat("yyyy-MM-dd");
  const counts = {
    found: 0,
    alreadyExported: 0,
    saved: 0,
    failed: 0,
    givenUp: 0,
    testPatients: 0,
    notShown: 0,
  };
  try {
    await exportDay(o, dayLabel, counts);
  } catch (e) {
    await o.ledger?.recordFailedCheck(dayLabel, counts).catch(() => {});
    throw e;
  }
  await o.ledger?.record(dayLabel, counts);
  return counts;
};

const exportDay = async (
  {
    context,
    page,
    day,
    state,
    outputDir,
    password,
    limit = 0,
    onFailure,
    manifestFile,
    stagingDir,
  },
  dayLabel,
  counts,
) => {
  const total = await searchSignedOn(page, day);
  counts.found = total;
  if (!total) return;

  // GEHRIMed pages results 10 at a time — switch to its largest page size.
  const pageSize = await showAllResults(page, total);
  const rows = await resultRows(page);
  if (!rows)
    throw new Error(
      `GEHRIMed reported ${total} result(s) but no result rows were found`,
    );
  const expected = Math.min(total, pageSize);
  let shown = await rows.count();
  for (let waited = 0; shown < expected && waited < 30_000; waited += 500) {
    await page.waitForTimeout(500); // rows render after the Per Page change
    shown = await rows.count();
  }
  if (shown < total) {
    counts.notShown = total - shown;
    console.warn(
      `   ⚠️  ${dayLabel}: GEHRIMed found ${total} but only ${shown} are on the results page — ` +
        `${counts.notShown} can't be reached. This day will not be marked complete.`,
    );
  }

  const columns = await readColumns(rows);
  const dayDir = path.join(outputDir, dayLabel);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "gehrimed-export-"));

  try {
    let downloaded = 0;
    let failuresInARow = 0;
    let snapshotTaken = false;
    for (let i = 0; i < shown; i++) {
      if (limit && downloaded >= limit) break;
      const row = rows.nth(i);
      let encounterId = null; // only real IDs are ever recorded in the state file
      try {
        const details = await readRowDetails(row, columns);
        encounterId = details.encounterId;

        if (state.isExported(encounterId)) {
          counts.alreadyExported++;
          continue;
        }
        if (state.hasGivenUp(encounterId)) {
          counts.givenUp++;
          continue;
        }
        if (await isTestPatient(row)) {
          counts.testPatients++;
          continue; // GEHRIMed test patients aren't real — not for billing
        }

        downloaded++;
        const baseName = buildPdfName(details);
        // Act on the row that has THIS encounter ID (not "row number i"), so a
        // table redraw between reading and downloading can't mix up patients.
        const thisRow = rows.filter({ hasText: encounterId }).first();
        const file = await downloadEncounter({
          context,
          page,
          row: (await thisRow.count()) ? thisRow : row,
          password,
          saveDir: work,
          baseName: encounterId,
          expectedEncounterId: encounterId,
        });
        const pdfs = await extractPdfs(
          file,
          password,
          path.join(work, encounterId),
        );

        await fs.mkdir(dayDir, { recursive: true });
        const dateOfService =
          parseGehrimedDate(details.dateOfService)?.toISODate() ?? null;
        const entries = [];
        for (const pdf of pdfs) {
          const sha256 = await sha256File(pdf);
          // The eCW upload's private copy goes first: if it fails, nothing has
          // been published yet, so the retry can't leave a _2 duplicate.
          if (stagingDir) {
            await stagePdf(stagingDir, pdf, sha256, {
              encounterId,
              lastName: details.lastName,
              dateOfBirth:
                parseGehrimedDate(details.dateOfBirth)?.toISODate() ?? null,
              dateOfService,
            });
          }
          await publish(pdf, dayDir, baseName);
          entries.push({
            encounterId,
            patientId: details.patientId,
            dateOfService,
            signedOn: dayLabel,
            sha256,
            exportedAt: new Date().toISOString(),
          });
        }
        if (manifestFile) await appendManifest(manifestFile, entries);

        await state.markExported(encounterId, dayLabel);
        counts.saved++;
        failuresInARow = 0;
        console.log(`   ✅ ${dayLabel} ${encounterId}`);
      } catch (e) {
        counts.failed++;
        failuresInARow++;
        const attempts = encounterId
          ? await state.markFailed(encounterId).catch(() => "?")
          : "-";
        console.error(
          `   ❌ ${dayLabel} ${encounterId ?? `row ${i + 1}`} (attempt ${attempts}/${state.MAX_ATTEMPTS}): ${e.message.split("\n")[0]}`,
        );
        logDetails(`${dayLabel} ${encounterId ?? `row ${i + 1}`}`, e); // full explanation → log file only
        if (onFailure && !snapshotTaken) await onFailure(e); // one snapshot per day is enough
        snapshotTaken = true;
        // (No Escape here: in GEHRIMed it closes the search window. downloadEncounter
        // closes whatever it opened itself.)
        if (failuresInARow >= MAX_FAILURES_IN_A_ROW) {
          throw new Error(
            `${MAX_FAILURES_IN_A_ROW} encounters in a row failed for ${dayLabel} — stopping this day (something is wrong, not just one note)`,
          );
        }
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
};

/**
 * Puts a PDF into the day folder as `base.pdf` (or base_2.pdf, ... if that name
 * is taken — same patient, same date of service). Never overwrites an existing
 * file. A plain copy (no hard links — OneDrive doesn't handle those well);
 * these PDFs are small, and OneDrive waits for the file to be closed before
 * uploading it.
 */
const publish = async (pdf, dayDir, base) => {
  for (let n = 1; n < 100; n++) {
    const name = `${base}${n > 1 ? `_${n}` : ""}.pdf`;
    try {
      await fs.copyFile(
        pdf,
        path.join(dayDir, name),
        fsConstants.COPYFILE_EXCL,
      ); // fails if it exists
      return name;
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
  }
  throw new Error(`Too many files named ${base}_N.pdf in ${dayDir}`);
};
