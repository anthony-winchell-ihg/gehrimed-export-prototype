import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import {
  deleteOldDayFolders,
  deleteOldFiles,
  deleteStaleTempFolders,
} from "./retention.js";

const today = DateTime.fromISO("2026-10-19", { zone: "America/New_York" });

describe("deleteOldDayFolders", () => {
  let dir;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "retention-"));
    for (const d of [
      "2026-10-10",
      "2026-10-12",
      "2026-10-13",
      "2026-10-18",
      "2026-10-19",
    ]) {
      await fs.mkdir(path.join(dir, d));
      await fs.writeFile(path.join(dir, d, "note.pdf"), "x");
    }
    await fs.mkdir(path.join(dir, "Keep Me")); // not a date folder
    await fs.writeFile(path.join(dir, "2026-01-01"), "x"); // a FILE named like a date
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("deletes date folders 7 or more days old and keeps the last 7 days", async () => {
    const deleted = await deleteOldDayFolders(dir, today, 7);
    assert.deepEqual(deleted, ["2026-10-10", "2026-10-12"]);
    const left = (await fs.readdir(dir)).sort();
    assert.deepEqual(left, [
      "2026-01-01",
      "2026-10-13",
      "2026-10-18",
      "2026-10-19",
      "Keep Me",
    ]);
  });

  it("never touches anything that isn't a date folder", async () => {
    await deleteOldDayFolders(dir, today, 0);
    const left = (await fs.readdir(dir)).sort();
    assert.ok(left.includes("Keep Me"));
    assert.ok(left.includes("2026-01-01"));
  });

  it("is fine when the output folder doesn't exist yet", async () => {
    assert.deepEqual(
      await deleteOldDayFolders(path.join(dir, "nope"), today, 7),
      [],
    );
  });
});

describe("deleteStaleTempFolders", () => {
  it("removes only our own old temp folders", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retention-temp-"));
    try {
      for (const d of [
        "gehrimed-export-old",
        "playwright-artifacts-old",
        "gehrimed-export-new",
        "someone-elses-folder",
      ]) {
        await fs.mkdir(path.join(dir, d));
      }
      const old = new Date(Date.now() - 7 * 60 * 60_000);
      for (const d of [
        "gehrimed-export-old",
        "playwright-artifacts-old",
        "someone-elses-folder",
      ]) {
        await fs.utimes(path.join(dir, d), old, old);
      }
      assert.equal(await deleteStaleTempFolders(dir, 6), 2);
      assert.deepEqual((await fs.readdir(dir)).sort(), [
        "gehrimed-export-new",
        "someone-elses-folder",
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("deleteOldFiles", () => {
  it("deletes only files older than the limit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "retention-files-"));
    try {
      await fs.writeFile(path.join(dir, "old.txt"), "x");
      await fs.writeFile(path.join(dir, "new.txt"), "x");
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
      await fs.utimes(path.join(dir, "old.txt"), eightDaysAgo, eightDaysAgo);
      assert.equal(await deleteOldFiles(dir, 7), 1);
      assert.deepEqual(await fs.readdir(dir), ["new.txt"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
