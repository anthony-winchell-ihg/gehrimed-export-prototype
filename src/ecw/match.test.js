import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { decideMatch } from "./match.js";

// Made-up patient. Tests never use real patient data.
const expected = {
  lastName: "Garcia-Lopez",
  dateOfBirth: DateTime.fromISO("1931-04-09"),
};
const row = (overrides = {}) => ({
  lastName: "GARCIA LOPEZ",
  dob: "04/09/1931",
  ...overrides,
});

describe("decideMatch", () => {
  it("matches one result with the same last name and DOB, ignoring case, spaces and hyphens", () => {
    assert.deepEqual(decideMatch([row()], expected), { result: "match" });
  });

  it("ignores accents", () => {
    assert.equal(
      decideMatch([row({ lastName: "García López" })], expected).result,
      "match",
    );
  });

  it("reports not-found for no results", () => {
    assert.equal(decideMatch([], expected).result, "not-found");
  });

  it("reports several for two results, even if both look right", () => {
    assert.equal(decideMatch([row(), row()], expected).result, "several");
  });

  it("rejects a DOB that is one day off", () => {
    const d = decideMatch([row({ dob: "04/10/1931" })], expected);
    assert.equal(d.result, "mismatch");
    assert.match(d.reason, /DOB/);
  });

  it("rejects a different last name", () => {
    const d = decideMatch([row({ lastName: "GARCIA" })], expected);
    assert.equal(d.result, "mismatch");
    assert.match(d.reason, /last name/);
  });

  describe("Jr / Sr / II / III / IV suffixes", () => {
    // The expected last name comes from the export's file name, where
    // GEHRIMed's "Testlast Jr." has become "Testlastjr".
    const dob = expected.dateOfBirth;
    const decide = (ecwLastName, expectedLastName) =>
      decideMatch([row({ lastName: ecwLastName })], {
        lastName: expectedLastName,
        dateOfBirth: dob,
      });

    it("matches when only GEHRIMed's last name has the suffix (glued on by the file name)", () => {
      for (const [ecw, ours] of [
        ["TESTLAST", "Testlastjr"],
        ["Testlast", "Testlastsr"],
        ["TESTLAST", "Testlastiii"],
        ["Test-Last", "Testlastiv"],
      ]) {
        const d = decide(ecw, ours);
        assert.equal(d.result, "match", `${ecw} / ${ours}`);
        assert.match(d.note, /suffix/);
      }
    });

    it("matches when only eCW's last name has the suffix", () => {
      for (const ecw of ["TESTLAST JR", "Testlast Jr.", "TESTLAST, SR", "Testlast II"]) {
        const d = decide(ecw, "Testlast");
        assert.equal(d.result, "match", ecw);
        assert.match(d.note, /suffix/);
      }
    });

    it("handles GEHRIMed's last name as staged, with its spaces and punctuation", () => {
      assert.match(decide("TESTLAST", "Testlast Jr.").note, /suffix/);
      assert.match(decide("TEST-LAST", "Test Last, III").note, /suffix/);
      assert.deepEqual(decide("TESTLAST JR", "Testlast Jr."), { result: "match" });
      assert.equal(decide("TESTLAST SR", "Testlast Jr.").result, "mismatch");
      assert.equal(decide("TESTLAST", "Otherlast Jr.").result, "mismatch");
    });

    it("matches the same suffix on both sides, with no note", () => {
      assert.deepEqual(decide("TESTLAST JR", "Testlastjr"), { result: "match" });
    });

    it("rejects two different suffixes (Jr vs Sr is father and son)", () => {
      assert.equal(decide("TESTLAST SR", "Testlastjr").result, "mismatch");
      assert.equal(decide("TESTLAST II", "Testlastiii").result, "mismatch");
    });

    it("rejects anything else glued on, and a suffix with no name in front", () => {
      assert.equal(decide("TESTLAST", "Testlastx").result, "mismatch");
      assert.equal(decide("TESTLAST", "Testlastjrx").result, "mismatch");
      assert.equal(decide("JR", "Testlast").result, "mismatch");
      assert.equal(decide("TESTLASTJR", "Testlast").result, "mismatch"); // no space: not a suffix word
    });

    it("still checks the DOB first", () => {
      const d = decideMatch([row({ lastName: "TESTLAST", dob: "04/10/1931" })], {
        lastName: "Testlastjr",
        dateOfBirth: dob,
      });
      assert.deepEqual(d, { result: "mismatch", reason: "DOB differs" });
    });
  });

  it("rejects an unreadable or missing DOB", () => {
    assert.equal(
      decideMatch([row({ dob: "not a date" })], expected).result,
      "mismatch",
    );
    assert.equal(
      decideMatch([row({ dob: undefined })], expected).result,
      "mismatch",
    );
  });

  it("throws when OUR side is missing data (a bug, not a data problem)", () => {
    assert.throws(
      () => decideMatch([row()], { lastName: "Garcia" }),
      /dateOfBirth/,
    );
    assert.throws(
      () =>
        decideMatch([row()], { lastName: "Garcia", dateOfBirth: "1931-04-09" }),
      /dateOfBirth/,
    );
    assert.throws(
      () => decideMatch([row()], { dateOfBirth: expected.dateOfBirth }),
      /lastName/,
    );
  });

  it("never puts patient details in the reason (it goes into logs)", () => {
    const reasons = [
      decideMatch([row({ dob: "04/10/1931" })], expected),
      decideMatch([row({ lastName: "SMITH" })], expected),
      decideMatch([], expected),
      decideMatch([row(), row()], expected),
    ].map((d) => d.reason);
    for (const reason of reasons)
      assert.doesNotMatch(reason, /garcia|smith|1931/i);
  });
});
