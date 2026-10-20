import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPdfName, parseGehrimedDate, uniqueName } from "./naming.js";

describe("buildPdfName", () => {
  it("is LastNameFirstName_DOBmm.dd.yyyy_DOSmm.dd.yyyy", () => {
    assert.equal(
      buildPdfName({ firstName: "JOHN", lastName: "SMITH", dateOfBirth: "4/9/1931", dateOfService: "10/12/2026" }),
      "SmithJohn_DOB04.09.1931_DOS10.12.2026",
    );
  });

  it("strips spaces, hyphens, apostrophes and accents from names", () => {
    assert.equal(
      buildPdfName({ firstName: "Mary-Jo", lastName: "O'Brien", dateOfBirth: "01/02/1940", dateOfService: "10/13/2026" }),
      "ObrienMaryjo_DOB01.02.1940_DOS10.13.2026",
    );
    assert.equal(
      buildPdfName({ firstName: "José", lastName: "De La Cruz", dateOfBirth: "1/2/1940", dateOfService: "10/13/2026" }),
      "DelacruzJose_DOB01.02.1940_DOS10.13.2026",
    );
  });

  it("refuses to guess when a piece is missing", () => {
    assert.throws(
      () => buildPdfName({ firstName: "", lastName: "SMITH", dateOfBirth: "bad", dateOfService: "10/12/2026" }),
      /first name, date of birth/,
    );
  });
});

describe("uniqueName", () => {
  it("adds _2, _3 for the same patient + date of service", () => {
    const used = new Set();
    const base = "SmithJohn_DOB04.09.1931_DOS10.12.2026";
    assert.equal(uniqueName(base, used), base);
    assert.equal(uniqueName(base, used), `${base}_2`);
    assert.equal(uniqueName(base, used), `${base}_3`);
  });
});

describe("parseGehrimedDate", () => {
  it("reads GEHRIMed's M/d/yyyy dates", () => {
    assert.equal(parseGehrimedDate("4/19/1931").toISODate(), "1931-04-19");
    assert.equal(parseGehrimedDate(" 10/12/2026 ").toISODate(), "2026-10-12");
    assert.equal(parseGehrimedDate("not a date"), null);
  });
});
