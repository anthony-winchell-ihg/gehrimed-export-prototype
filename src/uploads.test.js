import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadUploads } from "./uploads.js";

describe("upload record", () => {
  let file;
  beforeEach(async () => {
    // A fresh, empty folder for every test, so tests can't affect each other.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uploads-test-"));
    file = path.join(dir, "uploads.json");
  });

  it("is ready to upload an encounter it has never seen", async () => {
    const u = await loadUploads(file);
    assert.equal(u.status("E1"), null);
    assert.equal(u.readyToUpload("E1"), true);
  });

  it("remembers an upload after a restart", async () => {
    await (await loadUploads(file)).markUploaded("E1", "2026-10-12");
    const again = await loadUploads(file); // a new run reading the same file
    assert.equal(again.status("E1"), "uploaded");
    assert.equal(again.readyToUpload("E1"), false);
  });

  it("never re-uploads after a crash between 'started' and 'uploaded'", async () => {
    await (await loadUploads(file)).markStarted("E1", "2026-10-12");
    // ...crash here: markUploaded never happens...
    const again = await loadUploads(file);
    assert.equal(again.readyToUpload("E1"), false);
    assert.deepEqual(
      again.needsManual().map((m) => m.encounterId),
      ["E1"],
    );
    assert.match(again.needsManual()[0].reason, /may already be there/);
  });

  it("puts encounters a person must handle on the manual list, with the reason", async () => {
    const u = await loadUploads(file);
    await u.markNeedsManual("E2", "several patients have this External MRN");
    assert.equal(u.readyToUpload("E2"), false);
    assert.deepEqual(u.needsManual(), [
      { encounterId: "E2", reason: "several patients have this External MRN" },
    ]);
  });

  it("retries technical failures, then gives up and lists them", async () => {
    const u = await loadUploads(file);
    for (let i = 1; i < u.MAX_ATTEMPTS; i++) await u.markFailed("E3");
    assert.equal(u.readyToUpload("E3"), true); // 4 failures: still retried
    await u.markFailed("E3");
    assert.equal(u.readyToUpload("E3"), false); // 5: given up
    assert.match(u.needsManual()[0].reason, /failed 5 times/);
  });

  it("clears the failure count once an upload succeeds", async () => {
    const u = await loadUploads(file);
    await u.markFailed("E4");
    await u.markUploaded("E4", "2026-10-12");
    assert.deepEqual(u.needsManual(), []);
  });

  it("refuses to start from a damaged file instead of forgetting every upload", async () => {
    await fs.writeFile(file, "{ this is not json");
    await assert.rejects(() => loadUploads(file), /Could not read/);
  });
});
