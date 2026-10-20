// Steps 3–8: Advanced Search → Encounter → Date of Signature → <date>.
//
// Real GEHRIMed structure (inspected 2026-10-19):
//   • "Advanced Search" is <a id="advanced-search" class="btn ... dialog">; it opens #search-dialog
//   • criteria dropdowns are the first <a class="btn dropdown-toggle"> elements in
//     #search-dialog (category, field, operator), items <li><a>label</a></li> — only the <a> reacts
//   • the date box is <input id="SearchValue" type="date">, "Add" is <input type="submit">
//   • each criterion is <div class="btn-group print"><button class="manual-print">
//     <strong>Date of Signature</strong> <em>2026-10-13</em></button><button class="remove-criteria">×
//     </button></div>, next to <button class="remove-all-criteria">. Criteria are ANDed.
//   • old criteria are kept (even across sessions) but stay HIDDEN until a new
//     criterion is added — then they all reappear. So we add first, then check,
//     and Remove All + re-add if anything else is there.
//   • after a search the category dropdown keeps its value ("Encounter"), so pick
//     dropdowns by position, not by their current label.
//   • results table #search-results shows 10 rows per page; a "Per Page"
//     <select> offers 10/20/50/100/500
import {
  clickButton,
  clickText,
  control,
  findClickable,
  findVisible,
  framesDeepestFirst,
  step,
  waitForIdle,
} from "./ui.js";

/**
 * Runs the Date of Signature search for `date` — with exactly that one
 * criterion, nothing left over from earlier searches.
 *
 * @param page  Playwright page from openGehrimed()
 * @param date  Luxon DateTime — the day to search (only the date part is used)
 * @returns {Promise<number>} the "Results: N" count GEHRIMed reports
 */
export const searchSignedOn = async (page, date) => {
  const wanted = `Date of Signature is ${date.toFormat("yyyy-MM-dd")}`;

  // Reuse the Advanced Search window if it's still open from the previous search.
  let dialog = await findVisible(page, (f) => f.locator("#search-dialog"), "the Advanced Search window", {
    timeout: 1_000,
  }).catch(() => null);
  if (!dialog) {
    step("opening Search");
    await clickText(page, "Search");
    await waitForIdle(page);

    step("opening Advanced Search");
    await clickButton(page, "Advanced Search");
    await waitForIdle(page);
    dialog = await findVisible(page, (f) => f.locator("#search-dialog"), "the Advanced Search window", {
      timeout: 30_000,
    });
  }

  // GEHRIMed keeps old criteria HIDDEN until a new one is added — then they all
  // reappear together (inspected 2026-10-19). So: add our date, check the list,
  // and if anything else shows up, Remove All and add our date again.
  for (let attempt = 1; ; attempt++) {
    await addDateCriterion(page, dialog, date);
    const criteria = await readCriteria(dialog);
    if (criteria.length === 1 && criteria[0] === wanted) break;

    const found = criteria.map((c) => `"${c}"`).join(", ") || "(none)";
    if (attempt >= 3) {
      throw new Error(`Search criteria are wrong — expected only "${wanted}" but found: ${found}`);
    }
    step(`old search criteria came back (${found}) — removing all and adding ${date.toFormat("MM/dd/yyyy")} again`);
    await removeAllCriteria(page, dialog);
  }

  const total = await readResultCount(page, dialog);
  step(`GEHRIMed found ${total} encounter(s) for ${date.toFormat("MM/dd/yyyy")}`);
  return total;
};

/**
 * Reads "Results: N". With no matches GEHRIMed shows "No encounters found."
 * and leaves the count EMPTY (inspected 2026-10-19) — that's 0, not a failure.
 * Waits until the same answer is seen twice in a row, so a count left over
 * from the previous search isn't read by mistake.
 */
const readResultCount = async (page, dialog) => {
  const deadline = Date.now() + 60_000;
  let previous = null;
  for (;;) {
    const text = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ");
    const m = text.match(/Results:\s*(\d+)/);
    const now = m ? Number(m[1]) : /No encounters found/i.test(text) ? 0 : null;
    if (now !== null && now === previous) return now;
    previous = now;
    if (Date.now() > deadline) {
      throw new Error('GEHRIMed never showed "Results: N" or "No encounters found" for this search');
    }
    await page.waitForTimeout(750);
  }
};

/** Encounter → Date of Signature → <date> → Add. */
const addDateCriterion = async (page, dialog, date) => {
  step("choosing Encounter → Date of Signature");
  await pickFromDropdown(dialog, 0, "Encounter");
  await pickFromDropdown(dialog, 1, "Date of Signature");

  step(`entering ${date.toFormat("MM/dd/yyyy")} and adding the criterion`);
  const addButton = await findClickable(page, (f) => control(f.locator("#search-dialog"), "Add"), '"Add"');
  // Real value box: <input id="SearchValue">. GEHRIMed switches it from a text
  // box to a date box a moment AFTER "Date of Signature" shows in the dropdown —
  // so wait for that switch before typing, or the date goes in the wrong format.
  const byId = dialog.locator("#SearchValue");
  const valueBox = (await byId.count()) ? byId : addButton.locator("xpath=preceding::input[not(@type='hidden')][1]");
  await waitForDateBox(page, valueBox);
  await fillDate(valueBox, date);
  await addButton.click();
  await waitForIdle(page);
  await page.waitForTimeout(500); // let the criteria list re-render
};

/**
 * Reads the active criteria, e.g. ["Date of Signature is 2026-10-13"].
 * Real structure: one <div class="btn-group print"> per criterion, holding
 * <button class="manual-print"><strong>Date of Signature</strong> <em>2026-10-13</em></button>
 * plus a remove (×) button.
 */
export const readCriteria = async (dialog) => {
  const pills = dialog.locator(".btn-group.print button.manual-print").locator("visible=true");
  const out = [];
  for (let i = 0, n = await pills.count(); i < n; i++) {
    const pill = pills.nth(i);
    const field = (await pill.locator("strong").first().innerText().catch(() => "")).trim();
    const value = (await pill.locator("em").first().innerText().catch(() => "")).trim();
    out.push(`${field} is ${value}`);
  }
  return out;
};

/** Clicks "Remove All Search Criteria" and waits until the list is empty. */
const removeAllCriteria = async (page, dialog) => {
  const removeAll = dialog.locator(".remove-all-criteria").locator("visible=true").first();
  await removeAll.click({ timeout: 10_000 });
  await waitForIdle(page);
  for (let waited = 0; waited < 5_000; waited += 250) {
    if ((await readCriteria(dialog)).length === 0) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`"Remove All Search Criteria" left: ${(await readCriteria(dialog)).join("; ")}`);
};

/**
 * Opens the Nth criteria dropdown in the search window and picks `label`.
 * By position, because after a search the first dropdown already says
 * "Encounter" instead of "Patient".
 */
const pickFromDropdown = async (dialog, index, label) => {
  const toggle = dialog.locator("a.dropdown-toggle, button.dropdown-toggle").nth(index);
  const shown = async () => ((await toggle.innerText().catch(() => "")) || "").trim();
  if ((await shown()) === label) return; // already set

  const item = toggle
    .locator("xpath=..")
    .locator(".dropdown-menu a")
    .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) })
    .first();
  const page = dialog.page();
  const labelChanged = async (ms = 2_000) => {
    for (let waited = 0; waited < ms; waited += 250) {
      if ((await shown()) === label) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  // 1. Open the menu, wait until the item has finished appearing (Bootstrap
  //    animates it in — clicking mid-animation does nothing), then click it.
  await toggle.click();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click({ trial: true, timeout: 5_000 }); // waits until stable and not covered
  await item.click();
  if (await labelChanged()) return;

  // 2. Fallback: trigger the link's click handler directly.
  step(`dropdown ${index + 1} didn't change — retrying "${label}"`);
  await item.evaluate((el) => el.click());
  if (await labelChanged(5_000)) return;

  throw new Error(`Dropdown ${index + 1} still shows "${await shown()}" after choosing "${label}"`);
};

/**
 * GEHRIMed shows 10 results per page. Switch "Per Page" to the largest
 * option so every result is on one page. Returns the page size chosen.
 */
export const showAllResults = async (page, total) => {
  if (total <= 10) return 10;
  for (const frame of framesDeepestFirst(page)) {
    const select = frame
      .locator("select")
      .filter({ has: frame.locator("option", { hasText: /^\s*500\s*$/ }) })
      .first();
    if (!(await select.count().catch(() => 0))) continue;

    const options = (await select.locator("option").allInnerTexts()).map((t) => Number(t.trim())).filter(Boolean);
    const largest = Math.max(...options);
    step(`setting Per Page to ${largest}`);
    await select.selectOption({ label: String(largest) });
    await waitForIdle(page);
    return largest;
  }
  throw new Error(`GEHRIMed found ${total} results but no "Per Page" selector to show them all`);
};

// Waits (up to 5 s) for the value box to become <input type="date">.
const waitForDateBox = async (page, input) => {
  for (let waited = 0; waited < 5_000; waited += 200) {
    if ((await input.getAttribute("type").catch(() => null)) === "date") return;
    await page.waitForTimeout(200);
  }
};

// A native <input type="date"> needs yyyy-MM-dd; a plain text box gets MM/dd/yyyy.
// If the box changes type between checking and typing, retry in the other format.
const fillDate = async (input, date) => {
  const iso = date.toFormat("yyyy-MM-dd");
  const us = date.toFormat("MM/dd/yyyy");
  const type = (await input.getAttribute("type")) ?? "text";
  try {
    if (type === "date") await input.fill(iso);
    else await input.fill(us);
  } catch (e) {
    if (!/Malformed value/i.test(e.message)) throw e;
    await input.fill(iso); // it became a date box after all
  }
  if (type !== "date") await input.press("Tab");
};
