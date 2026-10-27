// Checks the fake eCW itself behaves like the real one: Patient Lookup, login,
// Patient Hub, Patient Docs and Add Local.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { MOCK_ECW_LOGIN, startMockEcw } from "./mock-ecw.js";

describe("fake eCW patient lookup", { timeout: 60_000 }, () => {
  let mock, browser, page;
  before(async () => {
    mock = await startMockEcw();
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(mock.url);
  });
  after(async () => {
    await browser?.close();
    await mock?.close();
  });

  const dialog = () => page.locator("#pt-lookup-modal-dialog");
  const rows = () => page.locator("#rule-table2 tbody tr");

  // Like a person would: pick the type, type the MRN, and wait for eCW's own
  // search (it searches by itself after the text changes; there's no button to press).
  const searchByExternalMrn = async (mrn) => {
    await dialog().locator("#searchBy").click();
    await dialog()
      .locator("#searchByMenu a", { hasText: "External MRN" })
      .click();
    await Promise.all([
      page.waitForResponse(/getPatients\.jsp/),
      dialog().locator("#searchText").fill(mrn),
    ]);
  };

  it("opens Patient Lookup from the search icon", async () => {
    await page.locator("a.icon-usersearch").click();
    await dialog().waitFor({ state: "visible" });
  });

  it("keeps the Search button disabled, like real eCW for ordinary search types", async () => {
    assert.equal(
      await dialog().getByRole("button", { name: "Search", exact: true }).isDisabled(),
      true,
    );
  });

  it("finds one chart for a normal External MRN, with 13 cells like the header", async () => {
    await searchByExternalMrn("GM100001");
    await rows().first().waitFor();
    assert.equal(await rows().count(), 1);
    assert.equal(await rows().first().locator("td").count(), 13);
    assert.equal(
      (await rows().first().locator("td").nth(6).innerText()).trim(),
      "01/02/1940",
    ); // DOB column
  });

  it("shows both charts when two share an External MRN", async () => {
    await searchByExternalMrn("GM100002");
    await page.waitForFunction(
      () => document.querySelectorAll("#rule-table2 tbody tr").length === 2,
    );
  });

  it("finds nothing for an unknown External MRN", async () => {
    await searchByExternalMrn("GM999999");
    await page.waitForFunction(
      () => document.querySelectorAll("#rule-table2 tbody tr").length === 0,
    );
  });

  it("recorded every search, and nothing was deleted", () => {
    // One change to the text = one search.
    assert.deepEqual(
      mock.state.searches.map((s) => s.q),
      ["GM100001", "GM100002", "GM999999"],
    );
    assert.ok(mock.state.searches.every((s) => s.by === "External MRN"));
    assert.equal(mock.state.deletes, 0);
  });
});

describe("fake eCW login", { timeout: 60_000 }, () => {
  let mock, browser, page;
  before(async () => {
    mock = await startMockEcw({ requireLogin: true });
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  after(async () => {
    await browser?.close();
    await mock?.close();
  });

  const enterUsername = async () => {
    await page.goto(mock.url);
    await page.locator("#doctorID").fill(MOCK_ECW_LOGIN.username);
    await page.locator("#nextStep").click();
    await page.locator("#passwordField").waitFor();
  };

  it("sends a logged-out visitor to the username page", async () => {
    await page.goto(mock.url);
    assert.match(page.url(), /login\/newLogin\.jsp$/);
    assert.equal(await page.title(), "Web EMR Login Page");
  });

  it("shows the password page again, with an error, for a wrong password", async () => {
    await enterUsername();
    await page.locator("#passwordField").fill("wrong");
    await page.locator("#Login").click();
    await page.locator(".error").waitFor();
    assert.equal(await page.locator("#passwordField").count(), 1);
    assert.equal(mock.state.failedLogins, 1);
  });

  it("waits on the email page until the link is clicked, then moves on by itself", async () => {
    await enterUsername();
    await page.locator("#passwordField").fill(MOCK_ECW_LOGIN.password);
    await page.locator("#Login").click();
    await page.waitForURL(/OTPVerification\.jsp$/);
    assert.equal(await page.locator("#resendOtpBtn").count(), 1);
    assert.equal(mock.state.emailsSent, 1);

    mock.confirmEmail();
    await page.locator("a.icon-usersearch").waitFor();
    assert.match(page.url(), /webemr\/index\.jsp$/);
  });

  it("stays logged in on the next visit, until the session expires", async () => {
    await page.goto(mock.url);
    await page.locator("a.icon-usersearch").waitFor();
    mock.expireSessions();
    await page.goto(mock.url);
    assert.match(page.url(), /login\/newLogin\.jsp$/);
  });
});

describe("fake eCW Patient Hub, Patient Docs and Add Local", { timeout: 90_000 }, () => {
  let browser, tmp, pdf;
  before(async () => {
    browser = await chromium.launch();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mock-ecw-docs-"));
    pdf = path.join(tmp, "2026-10-12 Progress Note.pdf");
    await fs.writeFile(pdf, "%PDF-1.4 made-up test document");
  });
  after(async () => {
    await browser?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Opens a fresh fake eCW and searches by External MRN, like a person would.
  const searched = async (mrn, options = {}) => {
    const mock = await startMockEcw(options);
    const page = await browser.newPage();
    await page.goto(mock.url);
    await page.locator("a.icon-usersearch").click();
    await page.locator("#searchBy").click();
    await page.locator("#searchByMenu a", { hasText: "External MRN" }).click();
    await Promise.all([page.waitForResponse(/getPatients\.jsp/), page.locator("#searchText").fill(mrn)]);
    await page.locator("#rule-table2 tbody tr").first().waitFor();
    return { mock, page };
  };
  const openChartDocuments = async (page) => {
    await page.locator("#patientSearchBtn11").click();
    await page.locator("#patient_hub").waitFor({ state: "visible" });
    await page.locator("#patient_hub #letterDropDown").click();
    await page.locator("#patient_hub a", { hasText: "Patient Doc - Web Mode" }).click();
    await page.locator("#modalPatientDocs a#pt_2").click();
    await page.locator("#modalPatientDocs a#pt_2.selected").waitFor();
  };

  it("opens the Patient Hub with the External MRN and DOB on screen", async () => {
    const { mock, page } = await searched("GM100001");
    await page.locator("#patientSearchBtn11").click();
    await page.locator("#patient_hub").waitFor({ state: "visible" });
    assert.equal(await page.locator('#patient_hub [ng-bind="PatientHubInfo.mrn"]').innerText(), "GM100001");
    assert.equal(await page.locator('#patient_hub [ng-bind="PatientHubInfo.dateOfBirth"]').innerText(), "01/02/1940");
    await mock.close();
  });

  it("asks before opening a partially merged chart, and 'No' leaves it closed", async () => {
    const { mock, page } = await searched("GM100004");
    await page.locator("#patientSearchBtn11").click();
    await page.locator(".bootbox", { hasText: "partially merged" }).waitFor();
    assert.equal(await page.locator("#patient_hub").isVisible(), false);
    await page.locator('.bootbox [data-bb-handler="cancel"]').click();
    assert.equal(mock.state.promptsAnsweredYes, 0);
    await mock.close();
  });

  it("counts a 'Yes' on the eEHX prompt as an export (a write the program must never cause)", async () => {
    const { mock, page } = await searched("GM100005");
    await page.locator("#patientSearchBtn11").click();
    await page.locator('.bootbox [data-bb-handler="confirm"]').click();
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 20 && mock.state.ehxExports === 0; i++) await page.waitForTimeout(100);
    });
    assert.equal(mock.state.ehxExports, 1);
    await mock.close();
  });

  it("shows the folder counts, and refuses Add Local with no folder selected", async () => {
    const { mock, page } = await searched("GM100001", { documents: [{ patientId: "300001", catid: 2, customName: "old note" }] });
    await page.locator("#patientSearchBtn11").click();
    await page.locator("#patient_hub #letterDropDown").click();
    await page.locator("#patient_hub a", { hasText: "Patient Doc - Web Mode" }).click();
    assert.equal(await page.locator("#modalPatientDocs a#pt_2").innerText(), "Chart Documents(1)");
    await page.locator("#patientdocsBtn4").click();
    await page.locator(".bootbox", { hasText: "Please select a category." }).waitFor();
    await mock.close();
  });

  it("uploads only after OK on the PDF warning, named after the file", async () => {
    const { mock, page } = await searched("GM100001");
    await openChartDocuments(page);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#patientdocsBtn4").click()]);
    await chooser.setFiles(pdf);
    await page.locator(".show-popup-for-pdf-upload").waitFor();
    assert.equal(mock.state.uploads.length, 0); // nothing yet: the warning is in the way
    await page.locator(".show-popup-for-pdf-upload button", { hasText: "OK" }).click();
    await page.locator("#modalPatientDocs a#pt_2", { hasText: "Chart Documents(1)" }).waitFor();
    assert.deepEqual(
      mock.state.uploads.map((u) => [u.externalMrn, u.catid, u.customName]),
      [["GM100001", 2, "2026-10-12 Progress Note"]],
    );
    await page.locator("#documentDetails").waitFor({ state: "visible" });
    await mock.close();
  });

  it("Cancel on the PDF warning uploads nothing", async () => {
    const { mock, page } = await searched("GM100001");
    await openChartDocuments(page);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#patientdocsBtn4").click()]);
    await chooser.setFiles(pdf);
    await page.locator(".show-popup-for-pdf-upload button", { hasText: "Cancel" }).click();
    await page.waitForTimeout(300);
    assert.equal(mock.state.uploads.length, 0);
    await mock.close();
  });

  it("with the warning switched off, choosing the file uploads at once", async () => {
    const { mock, page } = await searched("GM100001", { flattenWarning: false });
    await openChartDocuments(page);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#patientdocsBtn4").click()]);
    await chooser.setFiles(pdf);
    await page.locator("#modalPatientDocs a#pt_2", { hasText: "Chart Documents(1)" }).waitFor();
    assert.equal(mock.state.uploads.length, 1);
    await mock.close();
  });
});
