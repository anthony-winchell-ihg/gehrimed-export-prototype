// Runs the real ecw-watch.js (live mode for eCW) with --once against the fake
// eCW, with made-up PDFs and a manifest in a temp folder. --today pretends it's
// a given day, so the weekend catch-up can be tested on any day of the week.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendManifest, sha256File } from "../src/manifest.js";
import { MOCK_ECW_LOGIN, startMockEcw } from "./mock-ecw.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MONDAY = "2026-10-26";

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

describe("ecw-watch.js (live mode) against the fake eCW", { timeout: 300_000 }, () => {
  let mock, tmp, stateDir, outputDir;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecw-watch-test-"));
    stateDir = path.join(tmp, "state");
    outputDir = path.join(tmp, "output");
  });
  afterEach(async () => {
    await mock?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const envFor = (overrides = {}) => ({
    ECW_URL: mock.url,
    ECW_USERNAME: MOCK_ECW_LOGIN.username,
    ECW_PASSWORD: MOCK_ECW_LOGIN.password,
    STATE_FILE: path.join(stateDir, "exported.json"),
    OUTPUT_DIR: outputDir,
    LOG_DIR: path.join(tmp, "logs"),
    ...overrides,
  });
  const uploading = (overrides = {}) =>
    envFor({ ECW_UPLOAD_MODE: "upload", ECW_AUTOMATIC_UPLOADS: "on", ECW_UPLOAD_SIGNED_FROM: "2026-10-24", ...overrides });
  const watchOnce = (env, today = MONDAY) => runNode("ecw-watch.js", env, ["--once", "--today", today]);

  /** A made-up PDF in a day folder plus its manifest line, like the export writes. */
  const exported = async (encounterId, patientId, fileName, signedOn) => {
    const file = path.join(outputDir, signedOn, fileName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `fake pdf for ${encounterId}`);
    await appendManifest(path.join(stateDir, "manifest.jsonl"), [
      { encounterId, patientId, dateOfService: "2026-10-12", signedOn, sha256: await sha256File(file) },
    ]);
  };
  const uploadsJson = async () => JSON.parse(await fs.readFile(path.join(stateDir, "uploads.json"), "utf8"));

  it("check mode (the default) goes as far as Chart Documents and changes nothing", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);

    const { code, out } = await watchOnce(envFor());
    assert.equal(code, 0, out);
    assert.match(out, /E1 \(signed 2026-10-26\): ready/);
    assert.equal(mock.state.uploads.length, 0);
    await assert.rejects(() => fs.access(path.join(stateDir, "uploads.json")));
  });

  it("refuses to start in upload mode without ECW_AUTOMATIC_UPLOADS=on or a cutover date", async () => {
    mock = await startMockEcw({ requireLogin: true });
    const noSwitch = await watchOnce(uploading({ ECW_AUTOMATIC_UPLOADS: "" }));
    assert.equal(noSwitch.code, 2);
    assert.match(noSwitch.out, /ECW_AUTOMATIC_UPLOADS=on/);
    const noCutover = await watchOnce(uploading({ ECW_UPLOAD_SIGNED_FROM: "" }));
    assert.equal(noCutover.code, 2);
    assert.match(noCutover.out, /ECW_UPLOAD_SIGNED_FROM/);
    assert.equal(mock.state.logins, 0);
  });

  it("on Monday, uploads what was signed over the weekend — but nothing from before the cutover", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("FRI", "GM100003", "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf", "2026-10-23"); // before cutover
    await exported("SAT", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", "2026-10-24");
    await exported("SUN", "GM100003", "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf", "2026-10-25");

    const { code, out } = await watchOnce(uploading());
    assert.equal(code, 0, out);
    assert.deepEqual(mock.state.uploads.map((u) => u.externalMrn).sort(), ["GM100001", "GM100003"]);
    const record = (await uploadsJson()).uploads;
    assert.equal(record.SAT.status, "uploaded");
    assert.equal(record.SUN.status, "uploaded");
    assert.equal(record.FRI, undefined); // billing's, by the cutover agreement
  });

  it("the next check finds nothing new (never uploads twice)", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("SAT", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", "2026-10-24");
    await watchOnce(uploading());
    const { out } = await watchOnce(uploading());
    assert.match(out, /nothing new/);
    assert.equal(mock.state.uploads.length, 1);
  });

  it("puts charts eCW asks about on the manual list, and keeps going with the rest", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("E4", "GM100004", "TestlastdPatd_DOB04.05.1943_DOS10.12.2026.pdf", MONDAY); // partially merged
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);

    const { out } = await watchOnce(uploading());
    assert.match(out, /Manual list: 1 encounter/);
    assert.equal((await uploadsJson()).uploads.E4.status, "manual");
    assert.equal(mock.state.uploads.length, 1);
    assert.equal(mock.state.promptsAnsweredYes, 0);
  });

  it("stops logging in after ONE wrong password", async () => {
    mock = await startMockEcw({ requireLogin: true });
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);
    const { code, out } = await watchOnce(uploading({ ECW_PASSWORD: "wrong" }));
    assert.equal(code, 1);
    assert.match(out, /sign-in needs a person/);
    assert.equal(mock.state.failedLogins, 1);
  });

  it("stops uploading after an upload it isn't sure about", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500, failUploads: true });
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);
    await exported("E3", "GM100003", "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf", MONDAY);

    const { code, out } = await watchOnce(uploading());
    assert.equal(code, 1);
    assert.match(out, /Stopped uploading/);
    assert.equal((await uploadsJson()).uploads.E1.status, "started");
    assert.equal((await uploadsJson()).uploads.E3, undefined); // never tried after the uncertain one
  });

  it("writes its log to logs/ecw-watch-<date>.log, with no names or dates of birth", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);
    const { out } = await watchOnce(uploading());
    const [logFile] = (await fs.readdir(path.join(tmp, "logs"))).filter((f) => f.startsWith("ecw-watch-"));
    const logText = await fs.readFile(path.join(tmp, "logs", logFile), "utf8");
    assert.match(logText, /E1 \(signed 2026-10-26\): uploaded/);
    for (const text of [out, logText]) {
      assert.doesNotMatch(text, /testlast|pata/i);
      assert.doesNotMatch(text, /1940/);
    }
  });
});
