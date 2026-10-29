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

  it("keeps why an upload was uncertain, and still never retries it by itself", async () => {
    const u = await loadUploads(file);
    await u.markStarted("E5", "2026-10-12");
    await u.markUncertain("E5", "Chart Documents went from 11 to 11 documents");
    assert.equal(u.status("E5"), "started");
    assert.equal(u.readyToUpload("E5"), false);
    assert.match(u.needsManual()[0].reason, /may already be there \(Chart Documents went from 11 to 11/);
  });

  it("resolve: 'uploaded' takes it off the manual list for good, marked as done by a person", async () => {
    const u = await loadUploads(file);
    await u.markStarted("E6", "2026-10-12");
    assert.equal(await u.resolve("E6", "uploaded"), "started");
    assert.equal(u.status("E6"), "uploaded");
    assert.equal(u.readyToUpload("E6"), false);
    assert.deepEqual(u.needsManual(), []);
    const saved = JSON.parse(await fs.readFile(file, "utf8")).uploads.E6;
    assert.deepEqual([saved.by, saved.dateOfService], ["person", "2026-10-12"]);
  });

  it("resolve: 'retry' forgets it (and its failures), so the next check tries again", async () => {
    const u = await loadUploads(file);
    await u.markNeedsManual("E7", "mismatch: last name differs");
    for (let i = 0; i < u.MAX_ATTEMPTS; i++) await u.markFailed("E8");
    assert.equal(await u.resolve("E7", "retry"), "manual");
    assert.equal(await u.resolve("E8", "retry"), null);
    assert.equal(u.readyToUpload("E7"), true);
    assert.equal(u.readyToUpload("E8"), true);
    assert.deepEqual(u.needsManual(), []);
  });

  it("two programs writing at once keep each other's changes (ecw-watch + ecw-resolve)", async () => {
    const watcher = await loadUploads(file);
    await watcher.markStarted("E9", "2026-10-12");
    const person = await loadUploads(file); // ecw-resolve, run while the watcher keeps going
    await person.resolve("E9", "uploaded");
    await watcher.markUploaded("E10", "2026-10-12"); // the watcher's next save must not undo the person's
    const again = await loadUploads(file);
    assert.equal(again.status("E9"), "uploaded");
    assert.equal(again.status("E10"), "uploaded");
  });

  it("reload() picks up another program's change", async () => {
    const watcher = await loadUploads(file);
    await watcher.markStarted("E11", "2026-10-12");
    await (await loadUploads(file)).resolve("E11", "retry");
    assert.equal(watcher.status("E11"), "started"); // not seen yet
    await watcher.reload();
    assert.equal(watcher.readyToUpload("E11"), true);
  });

  it("refuses to start from a damaged file instead of forgetting every upload", async () => {
    await fs.writeFile(file, "{ this is not json");
    await assert.rejects(() => loadUploads(file), /Could not read/);
  });
});
