import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { assessDay, loadLedger } from "./ledger.js";
import { appendManifest, readManifest, sha256File } from "./manifest.js";

const today = DateTime.fromISO("2026-10-20", { zone: "America/New_York" }); // a Tuesday
const counts = (c) => ({
  found: 0,
  alreadyExported: 0,
  saved: 0,
  failed: 0,
  givenUp: 0,
  testPatients: 0,
  notShown: 0,
  ...c,
});
const entry = (e) => ({
  checks: 1,
  failedChecks: 0,
  failedAttempts: 0,
  signed: 0,
  exported: 0,
  testPatients: 0,
  failed: 0,
  givenUp: 0,
  notShown: 0,
  ...e,
});

describe("assessDay", () => {
  it("is ok when every signed note was exported or is a test patient", () => {
    assert.deepEqual(
      assessDay(
        "2026-10-19",
        entry({ signed: 33, exported: 32, testPatients: 1 }),
        today,
      ),
      { status: "ok", notes: [] },
    );
  });

  it("flags notes that were never on the results page", () => {
    const r = assessDay(
      "2026-10-19",
      entry({ signed: 600, exported: 500, notShown: 100 }),
      today,
    );
    assert.equal(r.status, "check");
    assert.match(r.notes.join(), /100 not on the results page/);
  });

  it("flags given-up encounters", () => {
    const r = assessDay(
      "2026-10-19",
      entry({ signed: 3, exported: 2, givenUp: 1 }),
      today,
    );
    assert.equal(r.status, "check");
    assert.match(r.notes.join(), /1 given up/);
  });

  it("flags 0 signed on a finished weekday, but not on a weekend or today", () => {
    assert.match(
      assessDay("2026-10-19", entry({}), today).notes.join(),
      /0 signed on a weekday/,
    ); // Monday
    assert.equal(assessDay("2026-10-18", entry({}), today).status, "ok"); // Sunday
    assert.equal(assessDay("2026-10-20", entry({}), today).status, "ok"); // today, still early
  });

  it("today with retries pending is 'open'; a finished day with notes missing needs a look", () => {
    assert.equal(
      assessDay(
        "2026-10-20",
        entry({ signed: 5, exported: 4, failed: 1 }),
        today,
      ).status,
      "open",
    );
    assert.equal(
      assessDay(
        "2026-10-19",
        entry({ signed: 5, exported: 4, failed: 1 }),
        today,
      ).status,
      "check",
    );
  });

  it("a day whose checks all stopped part-way needs a look", () => {
    assert.equal(
      assessDay(
        "2026-10-19",
        { checks: 2, failedChecks: 2, failedAttempts: 5 },
        today,
      ).status,
      "check",
    );
  });
});

describe("ledger and manifest files", () => {
  let dir;
  beforeEach(
    async () => (dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-"))),
  );
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("keeps the latest counts per day and running totals, across reloads", async () => {
    const file = path.join(dir, "ledger.json");
    let ledger = await loadLedger(file);
    await ledger.record(
      "2026-10-19",
      counts({ found: 3, saved: 2, failed: 1 }),
    );
    await ledger.recordFailedCheck("2026-10-19", counts({ failed: 5 }));
    ledger = await loadLedger(file);
    await ledger.record(
      "2026-10-19",
      counts({ found: 3, alreadyExported: 2, saved: 1 }),
    );

    const e = (await loadLedger(file)).days()["2026-10-19"];
    assert.equal(e.signed, 3);
    assert.equal(e.exported, 3);
    assert.equal(e.failed, 0);
    assert.equal(e.checks, 3);
    assert.equal(e.failedChecks, 1);
    assert.equal(e.failedAttempts, 6);
  });

  it("manifest: appends lines, reads them back, skips a damaged line", async () => {
    const file = path.join(dir, "manifest.jsonl");
    await appendManifest(file, [{ encounterId: "1" }, { encounterId: "2" }]);
    await fs.appendFile(file, "{half a line\n");
    await appendManifest(file, [{ encounterId: "3" }]);
    assert.deepEqual(
      (await readManifest(file)).map((m) => m.encounterId),
      ["1", "2", "3"],
    );
    assert.deepEqual(await readManifest(path.join(dir, "missing.jsonl")), []);
  });

  it("sha256File hashes the file contents", async () => {
    const f = path.join(dir, "a.txt");
    await fs.writeFile(f, "abc");
    assert.equal(
      await sha256File(f),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
