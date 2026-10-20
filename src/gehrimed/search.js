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

  const dialog = await openAdvancedSearch(page);

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

/**
 * Gets the Advanced Search window open, whatever state GEHRIMed is in.
 *
 * After a reload, GEHRIMed RESTORES windows that were open before (the Search
 * window has data-auto-refresh="True"), a moment after the page loads
 * (seen 2026-10-20). A restored window covers the left menu, so clicking
 * "Search" there fails. So: wait for that to settle, then
 *   • Advanced Search already open → use it
 *   • the Search window open       → click its "Advanced Search" button
 *   • neither                      → left menu "Search", then "Advanced Search"
 */
const openAdvancedSearch = async (page) => {
  const advanced = (f) => f.locator("#search-dialog");
  const simple = (f) => f.locator("#simple-search-dialog");

  await waitForIdle(page);
  // Give a restored window up to 3 s to appear before deciding.
  const which = await Promise.race([
    findVisible(page, advanced, "the Advanced Search window", { timeout: 3_000 }).then(() => "advanced"),
    findVisible(page, simple, "the Search window", { timeout: 3_000 }).then(() => "simple"),
  ]).catch(() => "none");
  await waitForIdle(page);

  if (which === "advanced") {
    step("Advanced Search is already open");
  } else {
    if (which === "simple") {
      step("Search window is already open");
    } else {
      step("opening Search");
      try {
        await clickText(page, "Search", { timeout: 15_000 });
      } catch (e) {
        // A window restored late may now be covering the menu — that's fine if
        // it's one of the search windows.
        const appeared = await findVisible(page, (f) => advanced(f).or(simple(f)), "a search window", { timeout: 2_000 })
          .then(() => true, () => false);
        if (!appeared) throw e;
        step("a search window opened on its own — using it");
      }
      await waitForIdle(page);
      if (await findVisible(page, advanced, "the Advanced Search window", { timeout: 1_000 }).then(() => true, () => false)) {
        return findVisible(page, advanced, "the Advanced Search window", { timeout: 5_000 });
      }
    }
    step("opening Advanced Search");
    await clickButton(page, "Advanced Search");
    await waitForIdle(page);
  }
  return findVisible(page, advanced, "the Advanced Search window", { timeout: 30_000 });
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
    if ((await readCriteria(dialog)).length === 0) {
      // GEHRIMed rebuilds the dropdowns a moment after this — give it time
      // before we start picking from them again.
      await page.waitForTimeout(1_000);
      await waitForIdle(page);
      return;
    }
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

  // GEHRIMed sometimes REBUILDS a dropdown's menu while it's open (seen right
  // after "Remove All", 2026-10-20): the item goes "not stable", then
  // "detached", and the new menu is closed. So the whole open-and-pick is
  // retried, reopening the menu each time.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Open the menu (if it isn't already), wait until the item has finished
      // appearing (Bootstrap animates it in — clicking mid-animation does
      // nothing), then click it.
      if (!(await item.isVisible().catch(() => false))) await toggle.click();
      await item.waitFor({ state: "visible", timeout: 5_000 });
      await item.click({ trial: true, timeout: 5_000 }); // waits until stable and not covered
      await item.click({ timeout: 5_000 });
      if (await labelChanged()) return;

      // Clicked, but the label didn't change: trigger the link's handler directly.
      await item.evaluate((el) => el.click());
      if (await labelChanged(3_000)) return;
      lastError = new Error(`Dropdown ${index + 1} still shows "${await shown()}" after choosing "${label}"`);
    } catch (e) {
      lastError = e; // item went stale or the menu closed under us
    }
    if ((await shown()) === label) return;
    step(`dropdown ${index + 1} wasn't ready — trying "${label}" again (${attempt}/3)`);
    await page.waitForTimeout(1_000); // let GEHRIMed finish rebuilding the menu
  }
  throw lastError;
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
