// Checks the fake eCW itself behaves like the real Patient Lookup.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
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
