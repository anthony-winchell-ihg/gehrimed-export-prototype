// Puts one PDF into the open chart's Chart Documents folder — the step that
// WRITES to eCW. Call it only after docs.js has opened Chart Documents for a
// chart that passed every check.
//
// Where the write happens: eCW's Add Local opens a file picker; choosing a PDF
// normally shows the "PDF Flatten" warning, and OK uploads. But if "Don't show
// this message again" was ever ticked for this user, choosing the file uploads
// it AT ONCE. So choosing the file counts as the write: `beforeWrite` (record
// "started" in uploads.js) runs before it, never after.
//
// Whether it worked is decided by eCW's own Chart Documents count, before and
// after: exactly one more = uploaded. Anything else is "not sure" and throws,
// leaving the record at "started" so a person checks the chart.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chartDocumentCount } from "./docs.js";
import { ecwFileName } from "./naming.js";

const ADD_LOCAL = "#modalPatientDocs #patientdocsBtn4";
const FLATTEN_WARNING = ".show-popup-for-pdf-upload";
const CONFIRM_WAIT_MS = 15 * 60_000; // how long confirm mode waits for the person
const WARNING_WAIT_MS = 10_000; // how long eCW gets to show the PDF warning after the file is chosen
const ARRIVAL_WAIT_MS = 60_000; // how long eCW gets to show the new document

/** Waits until Chart Documents holds at least `target` documents, or the time is up. Returns the last count. */
const waitForCount = async (page, target, timeout) => {
  const deadline = Date.now() + timeout;
  let count = await chartDocumentCount(page);
  while (count < target && Date.now() < deadline) {
    await page.waitForTimeout(500);
    count = await chartDocumentCount(page);
  }
  return count;
};

/**
 * Uploads `pdfPath` into the open Chart Documents folder as "<date of service> Progress Note".
 * @param {import("playwright").Page} page  with Chart Documents open and selected (docs.js)
 * @param {{ pdfPath: string, dateOfService: string, byPerson: boolean, beforeWrite: () => Promise<void>, log?: (msg: string) => void, warningWaitMs?: number, arrivalWaitMs?: number }} o
 *   byPerson: true = confirm mode (a person clicks OK on eCW's PDF warning); false = automatic
 *   beforeWrite: runs just before the file is chosen — record "started" here
 *   warningWaitMs / arrivalWaitMs: how long to wait for the PDF warning / the new document (shorter in tests)
 * @returns {Promise<{ uploaded: true } | { uploaded: false, reason: string }>}
 */
export const uploadToChartDocuments = async (
  page,
  {
    pdfPath,
    dateOfService,
    byPerson,
    beforeWrite,
    log = console.log,
    warningWaitMs = WARNING_WAIT_MS,
    arrivalWaitMs = ARRIVAL_WAIT_MS,
  },
) => {
  const before = await chartDocumentCount(page);

  // eCW names the document after the file, so upload a copy with the right name.
  // The "gehrimed-export-" prefix lets the retention cleanup remove it after a crash.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gehrimed-export-ecw-"));
  try {
    const file = path.join(dir, ecwFileName(dateOfService));
    await fs.copyFile(pdfPath, file);

    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }),
      page.locator(ADD_LOCAL).click(),
    ]);
    await beforeWrite(); // from the next line on, eCW may store the document
    await chooser.setFiles(file);

    const warning = page.locator(FLATTEN_WARNING);
    const warned = await warning
      .waitFor({ state: "visible", timeout: warningWaitMs })
      .then(
        () => true,
        () => false,
      );
    if (!warned) {
      log(
        "⚠️  eCW's PDF warning is switched off for this user: the file uploaded as soon as it was chosen. " +
          "Confirm mode can't pause it — turn the warning back on in eCW.",
      );
    } else if (byPerson) {
      log(
        "✋ Confirm mode: check the patient and the document in the browser, then click OK (upload) or Cancel " +
          `on eCW's PDF warning. Don't tick "Don't show this message again".`,
      );
      await warning.waitFor({ state: "hidden", timeout: CONFIRM_WAIT_MS });
    } else {
      await warning.locator("button", { hasText: /^\s*OK\s*$/ }).click();
    }

    const after = await waitForCount(page, before + 1, arrivalWaitMs);
    if (after === before + 1) return { uploaded: true };
    if (after === before && byPerson && warned)
      return { uploaded: false, reason: "Cancel was clicked in confirm mode" };
    throw new Error(
      `eCW: Chart Documents went from ${before} to ${after} documents — not sure the upload worked; check the chart`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};
