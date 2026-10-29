import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startMockEcw } from "./mock-ecw.js";
import { findByExternalMrn } from "../src/ecw/search.js";
import { openChartDocuments, openPatientHub } from "../src/ecw/docs.js";
import { uploadToChartDocuments } from "../src/ecw/upload.js";

describe("uploadToChartDocuments", { timeout: 180_000 }, () => {
  let browser, mock, page, tmp, pdf, pdfHash, logged;
  before(async () => {
    browser = await chromium.launch();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecw-upload-test-"));
    pdf = path.join(tmp, "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf"); // named like the export names it
    await fs.writeFile(pdf, "%PDF-1.4 made-up note");
    pdfHash = crypto
      .createHash("sha256")
      .update(await fs.readFile(pdf))
      .digest("hex");
  });
  after(async () => {
    await browser?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  beforeEach(() => (logged = []));
  afterEach(async () => {
    await page?.close();
    await mock?.close();
  });

  /** A fresh fake eCW with GM100001's Chart Documents open, the way the program gets there. */
  const atChartDocuments = async (options = {}) => {
    mock = await startMockEcw(options);
    page = await browser.newPage();
    await page.goto(mock.url);
    await findByExternalMrn(page, "GM100001");
    await openChartDocuments(page, await openPatientHub(page));
  };

  const upload = (overrides = {}) =>
    uploadToChartDocuments(page, {
      pdfPath: pdf,
      dateOfService: "2026-10-12",
      byPerson: false,
      beforeWrite: async () =>
        logged.push(`beforeWrite with ${mock.state.uploads.length} uploads`),
      log: (m) => logged.push(m),
      warningWaitMs: 2_000, // short waits: the fake answers at once
      arrivalWaitMs: 3_000,
      recheckWaitMs: 2_000,
      ...overrides,
    });

  /** Plays the person in confirm mode: clicks `button` on eCW's PDF warning when asked to. */
  const personClicks = (button) => (m) => {
    logged.push(m);
    if (/Confirm mode/.test(m))
      page
        .locator(".show-popup-for-pdf-upload button", { hasText: button })
        .click();
  };

  it("uploads the PDF once, into Chart Documents, named '<DOS> Progress Note'", async () => {
    await atChartDocuments();
    assert.deepEqual(await upload(), { uploaded: true });
    assert.equal(mock.state.uploads.length, 1);
    const [u] = mock.state.uploads;
    assert.deepEqual(
      [u.externalMrn, u.catid, u.customName],
      ["GM100001", 2, "2026-10-12 Progress Note"],
    );
    assert.equal(u.sha256, pdfHash); // the very same PDF, byte for byte
  });

  it("records 'started' BEFORE eCW has anything", async () => {
    await atChartDocuments();
    await upload();
    assert.equal(logged[0], "beforeWrite with 0 uploads");
  });

  it("confirm mode waits for the person, and uploads when they click OK", async () => {
    await atChartDocuments();
    assert.deepEqual(
      await upload({ byPerson: true, log: personClicks("OK") }),
      { uploaded: true },
    );
    assert.equal(mock.state.uploads.length, 1);
  });

  it("confirm mode: Cancel uploads nothing, and says so", async () => {
    await atChartDocuments();
    const result = await upload({
      byPerson: true,
      log: personClicks("Cancel"),
    });
    assert.equal(result.uploaded, false);
    assert.match(result.reason, /Cancel/);
    assert.equal(mock.state.uploads.length, 0);
  });

  it("warns loudly when eCW's PDF warning is switched off (the file uploads as soon as it's chosen)", async () => {
    await atChartDocuments({ flattenWarning: false });
    assert.deepEqual(await upload({ byPerson: true }), { uploaded: true });
    assert.match(logged.join("\n"), /warning is switched off/);
    assert.equal(logged[0], "beforeWrite with 0 uploads"); // still recorded first
  });

  it("throws (so the record stays 'started') when eCW doesn't show the new document", async () => {
    await atChartDocuments({ failUploads: true });
    await assert.rejects(() => upload(), /not sure the upload worked/);
  });

  it("counts again after opening the folder when only eCW's label was stale", async () => {
    await atChartDocuments({ staleCountAfterUpload: true });
    assert.deepEqual(await upload(), { uploaded: true });
    assert.equal(mock.state.uploads.length, 1); // still only once
    assert.match(logged.join("\n"), /only went up after opening the folder again/);
  });

  it("before giving up, logs what eCW showed: dialogs and upload requests, no patient details", async () => {
    await atChartDocuments({ failUploads: true, uploadErrorDialog: true });
    await assert.rejects(() => upload(), /not sure the upload worked/);
    const evidence = logged.find((m) => /What eCW showed/.test(m));
    assert.ok(evidence, logged.join("\n"));
    assert.match(evidence, /"eClinicalWorks" \[OK\]/);
    assert.match(evidence, /POST \/mock\/upload-document → 200/);
    assert.doesNotMatch(evidence, /testlast|pata|1940|GM100001/i);
  });

  it(`never ticks "Don't show this message again", and leaves no temp copy behind`, async () => {
    await atChartDocuments();
    const leftovers = async () =>
      (await fs.readdir(os.tmpdir())).filter((n) =>
        n.startsWith("gehrimed-export-ecw-"),
      ).length;
    const before = await leftovers();
    await upload();
    assert.equal(mock.state.flattenWarningTurnedOff, false);
    assert.equal(await leftovers(), before);
  });
});
