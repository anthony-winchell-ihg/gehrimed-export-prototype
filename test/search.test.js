// Searching one date and then another in the same page session must not
// carry the first date's criterion over (that returns "No encounters found").
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { DateTime } from "luxon";
import { MOCK_DAYS, startMock } from "./mock-gehrimed.js";
import { readCriteria, searchSignedOn } from "../src/gehrimed/search.js";
import { findVisible } from "../src/gehrimed/ui.js";

describe("searchSignedOn", { timeout: 90_000 }, () => {
  let mock, browser, page;
  before(async () => {
    mock = await startMock();
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(mock.url);
  });
  after(async () => {
    await browser.close();
    await mock.close();
  });

  const criteriaNow = async () =>
    readCriteria(await findVisible(page, (f) => f.locator("#search-dialog"), "search window"));

  it("clears a leftover criterion that appears late, and searches only the requested date", async () => {
    const total = await searchSignedOn(page, DateTime.fromISO("2026-10-13"));
    assert.equal(total, MOCK_DAYS["2026-10-13"].length);
    assert.deepEqual(await criteriaNow(), ["Date of Signature is 2026-10-13"]);
  });

  it("a second date in the same session replaces the first instead of piling up", async () => {
    const total = await searchSignedOn(page, DateTime.fromISO("2026-10-14"));
    assert.equal(total, MOCK_DAYS["2026-10-14"].length);
    assert.deepEqual(await criteriaNow(), ["Date of Signature is 2026-10-14"]);
  });

  it("and back again", async () => {
    const total = await searchSignedOn(page, DateTime.fromISO("2026-10-18"));
    assert.equal(total, 1);
    assert.deepEqual(await criteriaNow(), ["Date of Signature is 2026-10-18"]);
  });
});
