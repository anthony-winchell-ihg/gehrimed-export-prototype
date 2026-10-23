// Searches eCW's Patient Lookup by External MRN (= the GEHRIMed patient ID)
// and reads back each result's last name and DOB, for match.js to judge.
//
// It only READS: it never clicks a result row (every row has a "Delete
// Patient" icon). It reads cell text only, never tooltips (they hold names).
//
// The hard part is knowing the table shows the answer to THIS search: eCW
// leaves the previous rows on screen until the new ones are drawn. So it
// waits for this search's network reply, then for the table to change.

// How eCW searches (read from its own code, 2026-10-23): every change to the
// search box that leaves 2+ characters clears the results, then 500 ms later
// POSTs getPatients.jsp with the text as `primarySearchValue` (a form body).
// The Search button is only for custom "S …" fields; for External MRN it
// stays disabled. We wait for the reply whose request carries OUR MRN, so no
// other search can be mistaken for ours.

export const SEARCH_REQUEST = /\/catalog\/xml\/getPatients\.jsp/;
const LOOKUP = "#pt-lookup-modal-dialog";
const ROWS = "#rule-table2 tbody tr";
const RENDER_WAIT_MS = 3_000; // after the reply, how long the table gets to redraw

const exactly = (text) =>
  new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);

/** Opens patient Lookup, or reuses it if it's already open. Returns the window */
export const openPatientLookup = async (page) => {
  const dialog = page.locator(LOOKUP);
  if (!(await dialog.isVisible())) {
    await page.locator("a.icon-usersearch").click();
    await dialog.waitFor({ state: "visible", timeout: 15_000 });
  }

  return dialog;
};

/** Picks the Primary Search type (e.g. "External MRN") and confirms it took effect */
const chooseSearchBy = async (dialog, label) => {
  const group = dialog.locator("div.col-sm-12", {
    has: dialog.page().locator("#searchText"),
  });
  const current = group.locator(".cursorpoint").first();
  if (exactly(label).test(await current.innerText())) return;

  await current.click();
  await group
    .locator("ul.dropdown-menu a", { hasText: exactly(label) })
    .first()
    .click();

  try {
    await current
      .filter({ hasText: exactly(label) })
      .waitFor({ timeout: 5_000 });
  } catch {
    throw new Error(
      `eCW Patient Lookup: the search type didn't change to "${label}"`,
    );
  }
};

/** All result rows' text in one string - only compared, never logged (it holds PHI) */
const rowsSignature = (dialog) =>
  dialog
    .locator(ROWS)
    .evaluateAll((rows) => rows.map((r) => r.innerText).join("\n"));

/** Waits until the table differs from `before` and has stopped changing. */
const waitForNewResults = async (dialog, before) => {
  const page = dialog.page();
  const deadline = Date.now() + RENDER_WAIT_MS;
  let last = await rowsSignature(dialog);
  while (last === before && Date.now() < deadline) {
    await page.waitForTimeout(100);
    last = await rowsSignature(dialog);
  }

  // Changed (or the new answer is identical to the old one). Now make sure it's finished drawing.
  for (;;) {
    await page.waitForTimeout(200);
    const now = await rowsSignature(dialog);
    if (now === last) return;
    last = now;
  }
};

/** Reads Last Name and DOB from each row, finding the columns by their headers. */
const readResults = async (dialog) => {
  const headers = (await dialog.locator("table thead th").allInnerTexts()).map(
    (t) => t.trim(),
  );
  const lastNameCol = headers.indexOf("Last Name");
  const dobCol = headers.indexOf("DOB");
  if (lastNameCol < 0 || dobCol < 0)
    throw new Error(
      "eCW Patient Lookup: can't find the Last Name / DOB columns",
    );

  const rows = await dialog
    .locator(ROWS)
    .evaluateAll((trs) =>
      trs.map((tr) => [...tr.children].map((td) => td.innerText.trim())),
    );

  return rows.map((cells, i) => {
    if (cells.length !== headers.length) {
      throw new Error(
        `eCW Patient Lookup: result row ${i + 1} has ${cells.length} cells, the header has ${headers.length}`,
      );
    }
    return { lastName: cells[lastNameCol], dob: cells[dobCol] };
  });
};

/**
 * Searches Patient Lookup by External MRN.
 * @returns {Promise<{ lastName: string, dob: string }[]>} one entry per result row - feed to decideMatch()
 */
export const findByExternalMrn = async (page, externalMrn) => {
  const mrn = String(externalMrn ?? "").trim();
  if (!mrn) throw new Error("findByExternalMrn: External MRN is missing");

  const dialog = await openPatientLookup(page);
  await chooseSearchBy(dialog, "External MRN");

  // eCW searches by itself 500 ms after the text changes; for ordinary search
  // types its Search button stays disabled. Setting the same text again is no
  // change (no search), so empty the box first: too short to search.
  const box = dialog.locator("#searchText");
  await box.fill("");

  const before = await rowsSignature(dialog);
  await Promise.all([
    page.waitForResponse((r) => isSearchFor(r, mrn), { timeout: 30_000 }),
    box.fill(mrn),
  ]);
  await waitForNewResults(dialog, before);
  return readResults(dialog);
};

/** Is this eCW's reply to a search for 'mrn'? The MRN is in the request's form body. */
const isSearchFor = (response, mrn) =>
  SEARCH_REQUEST.test(response.url()) &&
  new URLSearchParams(response.request().postData() ?? "").get(
    "primarySearchValue",
  ) === mrn;
