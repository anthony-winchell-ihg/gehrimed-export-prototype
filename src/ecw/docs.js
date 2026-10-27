// After search.js has found exactly ONE matching chart: opens it and gets to
// the Chart Documents folder — everything up to Add Local. All READ-ONLY.
//
//   openPatientHub      clicks Patient Hub — never anything in the result row
//                       (it holds the Delete Patient icon) — and waits for the
//                       Hub, or for one of eCW's prompts (partially merged
//                       chart, merged/inactive chart, "export or link to
//                       eEHX?"). A prompt is NEVER answered: "Yes" can change
//                       data. It becomes a NeedsPersonError.
//   checkHubIdentity    re-checks, from the Hub's screen, that it's the right
//                       chart: External MRN, DOB, not marked inactive.
//   openChartDocuments  Patient Docs (Web Mode) → Chart Documents; returns how
//                       many documents it holds (the upload check compares it).
import { DateTime } from "luxon";

const LOOKUP = "#pt-lookup-modal-dialog";
const HUB = "#patient_hub";
const DOCS = "#modalPatientDocs";
const CHART_DOCUMENTS = "a#pt_2"; // eCW's folder ID for Chart Documents (mapped 2026-10-21)
// Any dialog other than the search window and the Hub. Their exact markup is
// an assumption until seen on live eCW, so this is deliberately broad.
const PROMPTS =
  ".bootbox, .modal:not(#patient-lookup-screen):not(#patient_hub)";

/** This encounter needs a person (and retrying won't change that). Not a bug, not a sign-in problem */
export class NeedsPersonError extends Error {
  name = "NeedsPersonError";
}

/** Waits until `locator` shows non-empty text (eCW fills some fields a moment after showing them). */
const shownText = async (locator, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = (
      await locator
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    if (text || Date.now() > deadline) return text;
    await locator.page().waitForTimeout(200);
  }
};

/**
 * Opens the Patient Hub for the one result in Patient Lookup.
 * Throws NeedsPersonError if eCW asks anything first (the question is left unanswered).
 * @returns {Promise<import("playwright").Locator>} the Hub
 */
export const openPatientHub = async (page) => {
  const rows = await page.locator(`${LOOKUP} #rule-table2 tbody tr`).count();
  if (rows !== 1)
    throw new Error(
      `eCW Patient Lookup: expected exactly 1 result row before opening, found ${rows}`,
    );

  const hub = page.locator(HUB);
  const prompt = page.locator(PROMPTS).filter({ visible: true });
  await page.locator(`${LOOKUP} #patientSearchBtn11`).click(); // "Patient Hub": opens the selected (only) row

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Prompt first: if both somehow show, the prompt wins
    if (await prompt.count()) {
      throw new NeedsPersonError(
        "eCW asked a question before opening the chart (merged / inactive / eEHX) - left unanswered",
      );
    }
    if (await hub.isVisible()) return hub;
    await page.waitForTimeout(250);
  }
  throw new Error("eCW: the Patient Hub didn't open");
};

/**
 * Re-checks on the Hub that this is the right chart. Throws NeedsPersonError if not.
 * @param {{ externalMrn: string, dateOfBirth: DateTime }} expected
 */
export const checkHubIdentity = async (hub, { externalMrn, dateOfBirth }) => {
  const mrn = await shownText(hub.locator('[ng-bind="PatientHubInfo.mrn"]'));
  const dob = DateTime.fromFormat(
    await shownText(hub.locator('[ng-bind="PatientHubInfo.dateOfBirth"]')),
    "MM/dd/yyyy",
  );
  const heading = await hub.locator(".modal-header").first().innerText();

  if (mrn !== String(externalMrn).trim())
    throw new NeedsPersonError(
      "the Patient Hub shows a different External MRN",
    );
  if (!dob.isValid || dob.toISODate() !== dateOfBirth.toISODate()) {
    throw new NeedsPersonError("the Patient Hub shows a different DOB");
  }

  if (/\binactive\b/i.test(heading))
    throw new NeedsPersonError("the patient is marked inactive in eCW");
};

/** Reads the number in the Chart Documents label, e.g. "Chart Documents(3)" → 3. */
export const chartDocumentCount = async (page) => {
  const label = await page.locator(`${DOCS} ${CHART_DOCUMENTS}`).innerText();
  const m = /^\s*Chart Documents\s*\((\d+)\)\s*$/.exec(label);
  if (!m)
    throw new Error(
      "eCW Patient Docs: the Chart Documents folder label isn't in the expected form",
    );
  return Number(m[1]);
};

/**
 * Opens Patient Docs in Web Mode and selects Chart Documents.
 * @returns {Promise<number>} how many documents Chart Documents holds now
 */
export const openChartDocuments = async (page, hub) => {
  await hub.locator("#letterDropDown").click();
  await hub.locator("a", { hasText: /^\s*Patient Doc - Web Mode\s*$/ }).click();
  await page.locator(DOCS).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(`${DOCS} ${CHART_DOCUMENTS}`).click();
  return chartDocumentCount(page);
};
