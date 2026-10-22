import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { getPreviousDayWindow, BILLING_ZONE } from "./dateWindow.js";

const ny = (iso) => DateTime.fromISO(iso, { zone: BILLING_ZONE });
const utcIso = (dt) => dt.toUTC().toISO();

describe("getPreviousDayWindow", () => {
  it("returns yesterday in New York", () => {
    const w = getPreviousDayWindow(ny("2026-10-19T07:00:00"));
    assert.equal(utcIso(w.start), "2026-10-18T04:00:00.000Z");
    assert.equal(utcIso(w.end), "2026-10-19T04:00:00.000Z");
  });

  it("uses New York's date even when UTC is already the next day", () => {
    const w = getPreviousDayWindow(
      DateTime.fromISO("2026-10-20T02:00:00Z", { zone: "utc" }),
    );
    assert.equal(w.start.toFormat("yyyy-MM-dd"), "2026-10-18");
  });
});
