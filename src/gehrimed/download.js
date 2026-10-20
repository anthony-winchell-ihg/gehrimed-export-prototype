// Steps 9–10: for one result row, View ▾ → Download → set password → save file.
//
// Real GEHRIMed row structure (inspected 2026-10-19), first cell:
//   <div class="btn-group dropright">
//     <a class="btn btn-default btn-xs dialog">View</a>
//     <span class="btn btn-default btn-xs dropdown-toggle" data-bs-toggle="dropdown"><span class="caret"></span></span>
//     <ul class="dropdown-menu"><li><a class="dialog">Print</a></li>
//                               <li><a class="dialog">Download</a></li>
//                               <li><a class="action">Resend</a></li></ul>
// Download opens #enter-password-dialog: one <input id="Password" type="password">
// and a "Submit" button; the form POSTs to /Encounter/Download.
import path from "node:path";
import { findVisible, framesDeepestFirst, menuItem, step, waitForIdle } from "./ui.js";

// A "View" control: button, link or styled element whose label is "View",
// optionally followed by a caret ("View ▾").
const VIEW_CONTROL = 'button, a, [role="button"], .btn, .dropdown-toggle';
const VIEW_TEXT = /^\s*View\W*$/;
const viewControls = (scope) => scope.locator(VIEW_CONTROL).filter({ hasText: VIEW_TEXT });
const rowsIn = (frame) => frame.locator("tr").filter({ has: viewControls(frame) });

/**
 * Result rows are the table rows that have a "View" control. Returns a
 * locator for all of them, in whichever frame the results table lives.
 */
export const resultRows = async (page) => {
  await findVisible(page, rowsIn, "result rows (table rows with a View button)", { timeout: 15_000 });
  for (const frame of framesDeepestFirst(page)) {
    const rows = rowsIn(frame);
    if ((await rows.count().catch(() => 0)) > 0) return rows;
  }
  return null;
};

/**
 * Maps column headers to positions, so we don't depend on column order.
 *
 * Real table (2026-10-19): <thead> has TWO rows — a notice ("Displaying the
 * first 500 results...", one cell with colspan=100) and then the real header
 * row, whose 13 cells line up with the 13 cells of each result row:
 *   (actions), Encounter ID, Last Name, First Name, Middle Name, Patient ID,
 *   Date of Birth, Date of Service, Seen By, Date of Signature, Facility,
 *   Primary CPT, Patient Status
 * So use the LAST header row only — counting every <th> shifts everything by one.
 */
export const readColumns = async (rows) => {
  const headerRow = rows.first().locator("xpath=ancestor::table[1]/thead/tr[last()]");
  const headers = await headerRow.locator("th, td").allTextContents();
  const cellCount = await rows.first().locator("td").count();
  if (headers.length !== cellCount) {
    throw new Error(`Results table header has ${headers.length} columns but rows have ${cellCount} — layout changed?`);
  }
  const find = (label) => headers.findIndex((h) => h.replace(/\s+/g, " ").trim().toLowerCase() === label.toLowerCase());
  const columns = {
    encounterId: find("Encounter ID"),
    firstName: find("First Name"),
    lastName: find("Last Name"),
    dateOfBirth: find("Date of Birth"),
    dateOfService: find("Date of Service"),
  };
  const missing = Object.entries(columns).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) throw new Error(`Results table is missing expected column(s): ${missing.join(", ")}`);
  // Optional: only recorded in the manifest, so a missing column doesn't stop the export.
  columns.patientId = find("Patient ID");
  return columns;
};

// Cell text via innerText (what's visible), NOT textContent: the First Name
// cell contains a hidden "Test" badge (<span class="label" data-bind="visible:
// TestPatient()">) that textContent would glue onto the name.
// Note: innerText is "" for everything if the search window gets closed —
// which is why nothing here ever presses Escape (that closes it).
const cellTexts = async (row) =>
  (await row.locator("td").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

/** True for GEHRIMed test patients (their visible "Test" badge). */
export const isTestPatient = async (row) =>
  (await row.locator("td span.label").filter({ hasText: /^\s*Test\s*$/i }).locator("visible=true").count()) > 0;

/** Reads the details used for the file name (and the manifest) from one result row. */
export const readRowDetails = async (row, columns) => {
  const cells = await cellTexts(row);
  const cell = (i) => cells[i] ?? "";
  return {
    encounterId: cell(columns.encounterId).match(/\d{6,}/)?.[0] ?? (await readEncounterId(row)),
    patientId: columns.patientId >= 0 ? cell(columns.patientId) || null : null,
    firstName: cell(columns.firstName),
    lastName: cell(columns.lastName),
    dateOfBirth: cell(columns.dateOfBirth),
    dateOfService: cell(columns.dateOfService),
  };
};

/** Reads the encounter ID (first long number in the row's cells). */
export const readEncounterId = async (row) => {
  for (const text of await cellTexts(row)) {
    const match = text.match(/^(\d{6,})/);
    if (match) return match[1];
  }
  throw new Error("Could not find an encounter ID in this row");
};

/**
 * Downloads one encounter's (password-protected) document.
 *
 * @param context   Playwright browser context (downloads can land on any tab)
 * @param page      Playwright page
 * @param row       locator for this encounter's result row
 * @param password  password to type into GEHRIMed's encryption prompt
 * @param saveDir   folder to save into
 * @param baseName  file name without extension (we use the encounter ID)
 * @param expectedEncounterId  the encounter this row is — checked against the download prompt
 * @returns {Promise<string>} path of the saved file
 */
export const downloadEncounter = async (opts) => {
  try {
    return await downloadEncounterSteps(opts);
  } catch (e) {
    await cleanUpAfterFailure(opts.page, opts.row);
    throw e;
  }
};

/**
 * Close only what this download left open — never press Escape blindly:
 * in GEHRIMed, Escape closes the whole search window, which hides every
 * remaining result row.
 */
const cleanUpAfterFailure = async (page, row) => {
  for (const frame of framesDeepestFirst(page)) {
    const prompt = frame.locator("#enter-password-dialog").locator("visible=true");
    if (await prompt.count().catch(() => 0)) {
      await prompt.getByText("Cancel", { exact: true }).first().click({ timeout: 5_000 }).catch(() => {});
    }
  }
  const openMenu = row.locator(".dropdown-menu.show").first();
  if (await openMenu.count().catch(() => 0)) {
    await row.locator(".dropdown-toggle").first().click({ timeout: 5_000 }).catch(() => {});
  }
};

const downloadEncounterSteps = async ({ context, page, row, password, saveDir, baseName, expectedEncounterId }) => {
  step("opening View ▾ menu");
  await row.scrollIntoViewIfNeeded();
  const toggle = row
    .locator(".dropdown-toggle, .dropdown-toggle-split, [data-toggle='dropdown'], [data-bs-toggle='dropdown']")
    .locator("visible=true")
    .first();
  if (await toggle.count()) {
    await toggle.click();
  } else {
    await viewControls(row).locator("visible=true").first().click();
  }

  // Only ever this row's "Download" item — never Print or Resend.
  step("clicking Download");
  const download = menuItem(row, "Download").locator("visible=true").first();
  await download.waitFor({ timeout: 10_000 });
  await download.click();

  step("filling the password prompt");
  const firstBox = await findVisible(page, (f) => f.locator('input[type="password"]'), "the password prompt", {
    timeout: 20_000,
  });

  // Safety check: the prompt carries the encounter it's about to download in a
  // hidden <input id="EncounterID">. If it isn't the encounter we read from the
  // row (and are about to name the file after), stop — never risk saving one
  // patient's note under another patient's name.
  if (expectedEncounterId) {
    const promptId = await firstBox
      .locator("xpath=ancestor::form[1]//input[@id='EncounterID' or @name='EncounterID']")
      .first()
      .inputValue({ timeout: 2_000 })
      .catch(() => "");
    if (promptId && promptId.trim() !== String(expectedEncounterId)) {
      throw new Error(`Download prompt is for encounter ${promptId.trim()}, not ${expectedEncounterId} — stopped to avoid a misnamed file`);
    }
  }

  for (const box of await visiblePasswordBoxes(page)) await box.fill(password);

  // Start listening for the download BEFORE submitting the prompt.
  const downloadPromise = waitForAnyDownload(context, 120_000);
  step("submitting the password prompt");
  await confirmPasswordPrompt(firstBox);
  step("waiting for the file");
  const file = await downloadPromise;

  // Name by encounter ID; keep only the extension from GEHRIMed's filename,
  // which may contain the patient's name.
  const ext = path.extname(file.suggestedFilename()) || ".bin";
  const savePath = path.join(saveDir, `${baseName}${ext}`);
  await file.saveAs(savePath);
  step(`saved (${ext})`);

  await waitForIdle(page);
  return savePath;
};

const visiblePasswordBoxes = async (page) => {
  for (const frame of framesDeepestFirst(page)) {
    const boxes = frame.locator('input[type="password"]').locator("visible=true");
    const n = await boxes.count().catch(() => 0);
    if (n > 0) return Array.from({ length: n }, (_, i) => boxes.nth(i));
  }
  return [];
};

// Click the prompt's Submit/OK button (in the same dialog); fall back to Enter.
const confirmPasswordPrompt = async (passwordBox) => {
  const dialog = passwordBox.locator(
    "xpath=ancestor::*[contains(@class,'modal') or @role='dialog'][1]",
  );
  const scope = (await dialog.count()) ? dialog : passwordBox.locator("xpath=ancestor::body");
  const confirm = scope
    .getByRole("button", { name: /^(ok|download|submit|continue|save|encrypt|export)$/i })
    .locator("visible=true")
    .first();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
  } else {
    await passwordBox.press("Enter");
  }
};

// A download can fire on the current tab or on a popup the click opens.
const waitForAnyDownload = (context, timeout) =>
  new Promise((resolve, reject) => {
    const cleanups = [];
    const done = (fn, value) => {
      cleanups.forEach((c) => c());
      fn(value);
    };
    const watch = (page) => {
      const handler = (d) => done(resolve, d);
      page.on("download", handler);
      cleanups.push(() => page.off("download", handler));
    };
    context.pages().forEach(watch);
    const onPage = (p) => watch(p);
    context.on("page", onPage);
    cleanups.push(() => context.off("page", onPage));
    const timer = setTimeout(() => done(reject, new Error("Download did not start within 2 minutes")), timeout);
    cleanups.push(() => clearTimeout(timer));
  });
