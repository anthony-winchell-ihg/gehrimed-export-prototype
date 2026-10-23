import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { DateTime } from "luxon";
import { startMockEcw } from "./mock-ecw.js";
import { findByExternalMrn } from "../src/ecw/search.js";
import { decideMatch } from "../src/ecw/match.js";

describe("findByExternalMrn", { timeout: 90_000 }, () => {
  let mock, browser, page;
  before(async () => {
    // A slow redraw (1 s) makes "reading the previous search's rows" easy to catch.
    mock = await startMockEcw({ searchDelayMs: 1_000 });
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await mock?.close();
  });
  beforeEach(async () => {
    page = await browser.newPage(); // fresh tab per test
    await page.goto(mock.url);
  });
  afterEach(async () => page?.close());

  it("finds one chart and reads its last name and DOB", async () => {
    assert.deepEqual(await findByExternalMrn(page, "GM100001"), [
      { lastName: "TESTLASTA", dob: "01/02/1940" },
    ]);
  });

  it("returns both charts when two share an External MRN", async () => {
    assert.equal((await findByExternalMrn(page, "GM100002")).length, 2);
  });

  it("returns nothing for an unknown External MRN", async () => {
    assert.deepEqual(await findByExternalMrn(page, "GM999999"), []);
  });

  it("never returns the PREVIOUS search's rows", async () => {
    await findByExternalMrn(page, "GM100002"); // two rows on screen
    assert.deepEqual(await findByExternalMrn(page, "GM999999"), []); // not the two old ones
    await findByExternalMrn(page, "GM100003"); // one row on screen
    assert.deepEqual(await findByExternalMrn(page, "GM100001"), [
      { lastName: "TESTLASTA", dob: "01/02/1940" },
    ]);
  });

  it("feeds decideMatch: a hyphenated eCW name still matches", async () => {
    const results = await findByExternalMrn(page, "GM100003");
    const expected = {
      lastName: "Test-Last C",
      dateOfBirth: DateTime.fromISO("1942-03-04"),
    };
    assert.equal(decideMatch(results, expected).result, "match");
  });

  it("refuses an empty External MRN instead of searching for everyone", async () => {
    await assert.rejects(
      () => findByExternalMrn(page, "  "),
      /External MRN is missing/,
    );
  });

  it("searched by External MRN every time, and never clicked Delete Patient", () => {
    assert.ok(mock.state.searches.length > 0);
    assert.ok(mock.state.searches.every((s) => s.by === "External MRN"));
    assert.equal(mock.state.deletes, 0);
  });
});
