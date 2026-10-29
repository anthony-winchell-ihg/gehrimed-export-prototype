import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { BILLING_ZONE } from "./dateWindow.js";
import {
  describeActiveHours,
  isActive,
  nextActiveStart,
  nextSlot,
  parseActiveHours,
} from "./activeHours.js";

const ny = (iso) => DateTime.fromISO(iso, { zone: BILLING_ZONE });
const fmt = (dt) => dt.setZone(BILLING_ZONE).toFormat("ccc yyyy-MM-dd HH:mm");
const weekdays = parseActiveHours("07:30-17:00", "mon-fri");

describe("active hours", () => {
  it("is active 07:30 up to (not including) 17:00 on weekdays", () => {
    assert.equal(isActive(ny("2026-10-21T07:29"), weekdays), false); // Wednesday
    assert.equal(isActive(ny("2026-10-21T07:30"), weekdays), true);
    assert.equal(isActive(ny("2026-10-21T16:59"), weekdays), true);
    assert.equal(isActive(ny("2026-10-21T17:00"), weekdays), false);
    assert.equal(isActive(ny("2026-10-24T10:00"), weekdays), false); // Saturday
  });

  it("uses New York time whatever zone the clock is in", () => {
    assert.equal(
      isActive(
        DateTime.fromISO("2026-10-21T12:00:00Z", { zone: "utc" }),
        weekdays,
      ),
      true,
    ); // 08:00 NY
    assert.equal(
      isActive(
        DateTime.fromISO("2026-10-21T21:30:00Z", { zone: "utc" }),
        weekdays,
      ),
      false,
    ); // 17:30 NY
  });

  it("finds the next start: later today, tomorrow, or Monday after a weekend", () => {
    assert.equal(
      fmt(nextActiveStart(ny("2026-10-21T06:00"), weekdays)),
      "Wed 2026-10-21 07:30",
    );
    assert.equal(
      fmt(nextActiveStart(ny("2026-10-21T17:05"), weekdays)),
      "Thu 2026-10-22 07:30",
    );
    assert.equal(
      fmt(nextActiveStart(ny("2026-10-23T17:00"), weekdays)),
      "Mon 2026-10-26 07:30",
    );
    assert.equal(
      fmt(nextActiveStart(ny("2026-10-25T23:00"), weekdays)),
      "Mon 2026-10-26 07:30",
    );
  });

  it("stays on 07:30 across a daylight-saving change", () => {
    // Clocks go back on Sunday 2026-11-01; spring forward on Sunday 2027-03-14.
    assert.equal(
      fmt(nextActiveStart(ny("2026-10-30T18:00"), weekdays)),
      "Mon 2026-11-02 07:30",
    );
    const daily = parseActiveHours("07:30-17:00", "all");
    assert.equal(
      fmt(nextActiveStart(ny("2027-03-14T00:30"), daily)),
      "Sun 2027-03-14 07:30",
    );
  });

  it("parses day lists, ranges that wrap, and 'always'", () => {
    assert.deepEqual(
      [...parseActiveHours("08:00-12:00", "mon,wed,fri").days],
      [1, 3, 5],
    );
    assert.deepEqual(
      [...parseActiveHours("08:00-12:00", "sat-mon").days].sort(),
      [1, 6, 7],
    );
    assert.equal(parseActiveHours("always", "all"), null);
    assert.equal(isActive(ny("2026-10-24T03:00"), null), true);
    assert.equal(
      isActive(ny("2026-10-24T03:00"), parseActiveHours("always", "mon-fri")),
      false,
    );
    assert.equal(
      describeActiveHours(weekdays),
      "07:30–17:00 mon,tue,wed,thu,fri",
    );
  });

  it("rejects settings it can't understand", () => {
    assert.throws(
      () => parseActiveHours("7:30", "mon-fri"),
      /should look like/,
    );
    assert.throws(
      () => parseActiveHours("17:00-07:30", "mon-fri"),
      /end must be after start/,
    );
    assert.throws(
      () => parseActiveHours("07:30-17:00", "weekdays"),
      /unknown day/,
    );
  });
});

describe("nextSlot", () => {
  const MIN = 60_000;
  const at = (iso, offsetMin = 10) => nextSlot(ny(iso), 30 * MIN, offsetMin * MIN).toFormat("yyyy-MM-dd HH:mm:ss");

  it("every 30 min with a 10 min offset is :10 and :40, whenever it's asked", () => {
    assert.equal(at("2026-10-29T08:30:00"), "2026-10-29 08:40:00");
    assert.equal(at("2026-10-29T08:39:59"), "2026-10-29 08:40:00");
    assert.equal(at("2026-10-29T08:40:00"), "2026-10-29 09:10:00"); // strictly after
    assert.equal(at("2026-10-29T11:47:12"), "2026-10-29 12:10:00");
  });

  it("with no offset, :00 and :30", () => {
    assert.equal(at("2026-10-29T08:30:00", 0), "2026-10-29 09:00:00");
    assert.equal(at("2026-10-29T08:31:00", 0), "2026-10-29 09:00:00");
  });

  it("rolls over midnight onto the next day's first slot", () => {
    assert.equal(at("2026-10-29T23:45:00"), "2026-10-30 00:10:00");
  });

  it("keeps wall-clock times on daylight-saving days", () => {
    assert.equal(at("2026-11-01T08:35:00"), "2026-11-01 08:40:00"); // clocks went back at 02:00
    assert.equal(at("2026-03-08T08:35:00"), "2026-03-08 08:40:00"); // clocks went forward
  });

  it("works for short test intervals too (seconds)", () => {
    assert.equal(nextSlot(ny("2026-10-29T08:30:01"), 3_000, 0).toFormat("HH:mm:ss"), "08:30:03");
  });
});
