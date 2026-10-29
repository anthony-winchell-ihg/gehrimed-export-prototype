// Runs the real ecw-resolve.js command on an upload record in a temp folder.
// Environment variables point it there: it never reads .env.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUploads } from "../src/uploads.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const runNode = (script, env, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

describe("ecw-resolve.js", () => {
  let tmp, env, uploadsFile;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecw-resolve-test-"));
    env = { STATE_FILE: path.join(tmp, "exported.json") };
    uploadsFile = path.join(tmp, "uploads.json");
    const u = await loadUploads(uploadsFile);
    await u.markStarted("E1", "2026-10-12");
    await u.markNeedsManual("E2", "mismatch: last name differs");
    await u.markUploaded("E3", "2026-10-12");
  });
  afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

  const resolve = (...args) => runNode("ecw-resolve.js", env, args);
  const status = async (id) => (await loadUploads(uploadsFile)).status(id);

  it("with no arguments, shows the manual list and how to resolve", async () => {
    const { code, out } = await resolve();
    assert.equal(code, 0, out);
    assert.match(out, /Manual list: 2 encounter/);
    assert.match(out, /E1: upload was interrupted/);
    assert.match(out, /E2: mismatch: last name differs/);
    assert.match(out, /--uploaded/);
  });

  it("--uploaded marks it uploaded; --retry makes it ready to try again", async () => {
    assert.equal((await resolve("E1", "--uploaded")).code, 0);
    assert.equal(await status("E1"), "uploaded");
    const retry = await resolve("E2", "--retry");
    assert.equal(retry.code, 0, retry.out);
    assert.equal(await status("E2"), null);
    assert.match((await resolve()).out, /manual list is empty/);
  });

  it("warns that a retried interrupted upload should only be retried after checking the chart", async () => {
    const { out } = await resolve("E1", "--retry");
    assert.match(out, /checked the chart and it's NOT there/);
  });

  it("refuses encounters that aren't on the manual list, and unclear requests", async () => {
    const notListed = await resolve("E3", "--retry");
    assert.equal(notListed.code, 2);
    assert.match(notListed.out, /isn't on the manual list \(its status is "uploaded"\)/);
    assert.equal(await status("E3"), "uploaded"); // untouched

    assert.equal((await resolve("E9", "--uploaded")).code, 2); // never seen
    assert.equal((await resolve("E1")).code, 2); // neither --uploaded nor --retry
    assert.equal((await resolve("E1", "--uploaded", "--retry")).code, 2);
    assert.equal((await resolve("--uploaded")).code, 2); // no encounter
    assert.equal(await status("E1"), "started");
  });
});
