// The debug snapshot must describe controls but never include patient data.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { DateTime } from "luxon";
import { startMock } from "./mock-gehrimed.js";
import { searchSignedOn } from "../src/gehrimed/search.js";
import { saveSnapshot } from "../src/gehrimed/snapshot.js";

describe("debug snapshot", { timeout: 60_000 }, () => {
  let mock, browser, outDir;
  before(async () => {
    mock = await startMock();
    browser = await chromium.launch();
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-test-"));
  });
  after(async () => {
    await browser.close();
    await mock.close();
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it("lists controls but leaves out table rows, input values and the dashboard frame", async () => {
    const page = await browser.newPage();
    await page.goto(mock.url, { waitUntil: "domcontentloaded" }); // like session.js: don't wait for the slow "load" event
    const total = await searchSignedOn(page, DateTime.fromISO("2026-10-13"));
    assert.equal(total, 25);

    const file = await saveSnapshot(page, outDir, "test");
    const text = await fs.readFile(file, "utf8");

    // Controls are there
    assert.match(text, /id="advanced-search".*"Advanced Search"/);
    assert.match(text, /dropdown-toggle/);
    assert.match(text, /id="SearchValue"/);
    assert.match(text, /"Search criteria:"/);

    // Result rows: structure and button labels only
    assert.match(
      text,
      /\[row 1\] <a class="btn-xs btn btn-default dialog"> "View"/,
    );
    assert.match(
      text,
      /\[row 1\] <span data-bs-toggle="dropdown" class="btn btn-default btn-xs dropdown-toggle"/,
    );
    assert.match(text, /\[row 1\] <a class="dialog"> "Download"/);
    assert.doesNotMatch(text, /\[row 3\]/); // only first two rows

    // Patient data and input values are not
    assert.doesNotMatch(text, /TESTLAST|TESTFIRST/);
    assert.doesNotMatch(text, /9000001\d\d/);
    assert.doesNotMatch(text, /value=/); // input values are never captured
    // The active search criterion IS listed (a search setting, not patient data) — handy for debugging.
    assert.match(text, /manual-print"> "Date of Signature 2026-10-13"/);
    assert.match(text, /skipped — dashboard\/scheduler frame/);
  });
});
