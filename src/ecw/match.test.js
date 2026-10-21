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
