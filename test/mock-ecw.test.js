// Checks the fake eCW itself behaves like the real Patient Lookup.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startMockEcw } from "./mock-ecw.js";

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
