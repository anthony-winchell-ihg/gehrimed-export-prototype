import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPdfName, parseGehrimedDate, parsePdfName, uniqueName } from "./naming.js";
import { decideMatch } from "./ecw/match.js";

describe("buildPdfName", () => {
  it("is LastNameFirstName_DOBmm.dd.yyyy_DOSmm.dd.yyyy", () => {
    assert.equal(
      buildPdfName({
        firstName: "JOHN",
        lastName: "SMITH",
        dateOfBirth: "4/9/1931",
        dateOfService: "10/12/2026",
      }),
      "SmithJohn_DOB04.09.1931_DOS10.12.2026",
    );
  });

  it("strips spaces, hyphens, apostrophes and accents from names", () => {
    assert.equal(
      buildPdfName({
        firstName: "Mary-Jo",
        lastName: "O'Brien",
        dateOfBirth: "01/02/1940",
        dateOfService: "10/13/2026",
      }),
      "ObrienMaryjo_DOB01.02.1940_DOS10.13.2026",
    );
    assert.equal(
      buildPdfName({
        firstName: "José",
        lastName: "De La Cruz",
        dateOfBirth: "1/2/1940",
        dateOfService: "10/13/2026",
      }),
      "DelacruzJose_DOB01.02.1940_DOS10.13.2026",
    );
  });

  it("refuses to guess when a piece is missing", () => {
    assert.throws(
      () =>
        buildPdfName({
          firstName: "",
          lastName: "SMITH",
          dateOfBirth: "bad",
          dateOfService: "10/12/2026",
        }),
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

describe("parsePdfName", () => {
  it("reads back what buildPdfName wrote", () => {
    const name = buildPdfName({
      firstName: "MARY-JO",
      lastName: "O'BRIEN",
      dateOfBirth: "4/9/1931",
      dateOfService: "10/12/2026",
    });
    const p = parsePdfName(`${name}.pdf`);
    assert.equal(p.lastName, "Obrien");
    assert.equal(p.firstName, "Maryjo");
    assert.equal(p.dateOfBirth.toISODate(), "1931-04-09");
    assert.equal(p.dateOfService.toISODate(), "2026-10-12");
  });

  it("accepts the _2 suffix for a second encounter on the same day", () => {
    assert.equal(
      parsePdfName("SmithJohn_DOB01.02.1950_DOS10.12.2026_2.pdf").lastName,
      "Smith",
    );
  });

  it("returns null for names not in the exact format (e.g. renamed by billing)", () => {
    for (const bad of [
      "scan001.pdf",
      "SmithJohn.pdf",
      "smithjohn_DOB01.02.1950_DOS10.12.2026.pdf", // no capitals: can't split last/first
      "SmithJohnPaul_DOB01.02.1950_DOS10.12.2026.pdf", // three name parts
      "SmithJohn_DOB13.45.1950_DOS10.12.2026.pdf", // not a real date
      "SmithJohn_DOB01.02.1950_DOS10.12.2026.pdf.tmp",
      undefined,
    ]) {
      assert.equal(parsePdfName(bad), null, String(bad));
    }
  });

  it("gives decideMatch what it needs: matches eCW's spelling of the same patient", () => {
    const p = parsePdfName("ObrienMaryjo_DOB04.09.1931_DOS10.12.2026.pdf");
    assert.equal(
      decideMatch([{ lastName: "O'BRIEN", dob: "04/09/1931" }], p).result,
      "match",
    );
  });
});
