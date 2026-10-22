import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildEcwDocName, ecwFileName } from "./naming.js";

describe("eCW document name", () => {
  it("uses the date of service as yyyy-MM-dd", () => {
    assert.equal(buildEcwDocName("10/12/2026"), "2026-10-12 Progress Note");
  });

  it("pads single-digit months and days (GEHRIMed writes 1/5/2026)", () => {
    assert.equal(buildEcwDocName("1/5/2026"), "2026-01-05 Progress Note");
  });

  it("accepts the manifest's ISO dates and Luxon dates", () => {
    assert.equal(buildEcwDocName("2026-10-12"), "2026-10-12 Progress Note");
    assert.equal(
      buildEcwDocName(DateTime.fromISO("2026-10-12")),
      "2026-10-12 Progress Note",
    );
  });

  it("adds .pdf for the file to upload", () => {
    assert.equal(ecwFileName("10/12/2026"), "2026-10-12 Progress Note.pdf");
  });

  it("refuses a missing or unreadable date instead of naming the document badly", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "not a date",
      DateTime.invalid("test"),
    ]) {
      assert.throws(() => buildEcwDocName(bad), /date of service/);
    }
  });

  it("is a valid Windows file name", () => {
    assert.doesNotMatch(ecwFileName("10/12/2026"), /[\\/:*?"<>|]/);
  });
});
