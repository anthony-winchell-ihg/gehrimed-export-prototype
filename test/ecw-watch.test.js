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
import { stagePdf } from "../src/staging.js";
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
    // Retries: a browser from a killed watcher may hold its profile for a moment (Windows).
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
  /** Same, plus the private staging copy the export now keeps, with the name as GEHRIMed shows it. */
  const exportedAndStaged = async (encounterId, patientId, fileName, signedOn, { lastName, dateOfBirth }) => {
    await exported(encounterId, patientId, fileName, signedOn);
    const file = path.join(outputDir, signedOn, fileName);
    await stagePdf(path.join(stateDir, "staging"), file, await sha256File(file), {
      encounterId,
      lastName,
      dateOfBirth,
      dateOfService: "2026-10-12",
    });
    return file;
  };
  const uploadsJson = async () => JSON.parse(await fs.readFile(path.join(stateDir, "uploads.json"), "utf8"));

  it("check mode (the default) goes as far as Chart Documents and changes nothing", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);

    const { code, out } = await watchOnce(envFor());
    assert.equal(code, 0, out);
    assert.match(out, /every 30 min \(:10, :40…\)/); // 10 minutes after the exporter's :00 / :30
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

  it("uploads a patient whose GEHRIMed last name has a Jr. suffix (eCW keeps it separately), and says so", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported("JR", "GM100008", "TestlasthjrPath_DOB08.09.1947_DOS10.12.2026.pdf", MONDAY); // how the export names "Testlasth Jr."
    const { code, out } = await watchOnce(uploading());
    assert.equal(code, 0, out);
    assert.match(out, /JR \(signed 2026-10-26\): uploaded \(last name matched ignoring a Jr\/Sr\/II\/III\/IV suffix\)/);
    assert.equal((await uploadsJson()).uploads.JR.status, "uploaded");
    assert.deepEqual(mock.state.uploads.map((u) => u.externalMrn), ["GM100008"]);
  });

  it("uploads the staged copy, then moves the Teams PDF into Uploaded\\ and deletes the staged copy", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    const kept = await exportedAndStaged("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY, {
      lastName: "TESTLASTA",
      dateOfBirth: "1940-01-02",
    });
    const taken = await exportedAndStaged("JR", "GM100008", "TestlasthjrPath_DOB08.09.1947_DOS10.12.2026.pdf", MONDAY, {
      lastName: "TESTLASTH JR.",
      dateOfBirth: "1947-08-09",
    });
    await fs.rm(taken); // billing already took this one out of the Teams folder

    const { code, out } = await watchOnce(uploading());
    assert.equal(code, 0, out);
    assert.match(out, /E1 \(signed 2026-10-26\): uploaded/);
    assert.match(out, /JR \(signed 2026-10-26\): uploaded \(last name matched ignoring/);
    assert.match(out, /Moved 1 uploaded PDF\(s\) into Uploaded\\/);
    assert.deepEqual(mock.state.uploads.map((u) => u.externalMrn).sort(), ["GM100001", "GM100008"]);

    const dayDir = path.dirname(kept);
    assert.deepEqual(await fs.readdir(dayDir), ["Uploaded"]); // nothing left for billing to do
    assert.deepEqual(await fs.readdir(path.join(dayDir, "Uploaded")), [path.basename(kept)]);
    assert.deepEqual(await fs.readdir(path.join(stateDir, "staging")), []); // patient data gone once uploaded
  });

  it("check mode moves nothing and deletes nothing", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    const file = await exportedAndStaged("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY, {
      lastName: "TESTLASTA",
      dateOfBirth: "1940-01-02",
    });
    const { code, out } = await watchOnce(envFor());
    assert.equal(code, 0, out);
    await fs.access(file);
    assert.equal((await fs.readdir(path.join(stateDir, "staging"))).length, 2);
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

  it("after an uncertain upload, starts again once a person runs ecw-resolve — same browser, no new login", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500, failUploads: true });
    await exported("E1", "GM100001", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", MONDAY);
    await exported("E3", "GM100003", "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf", MONDAY);

    // Live mode, checking every 3 seconds, around the clock, on the 3-second grid.
    const env = uploading({ ECW_ACTIVE_HOURS: "always", ECW_ACTIVE_DAYS: "all", ECW_CHECK_OFFSET_MINUTES: "0" });
    const child = spawn(process.execPath, ["ecw-watch.js", "--interval", "0.05", "--today", MONDAY], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const waitFor = async (pattern, ms = 120_000) => {
      for (const deadline = Date.now() + ms; !pattern.test(out); ) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`never saw ${pattern}:\n${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    try {
      await waitFor(/Stopped uploading/);
      await waitFor(/Not checking: not sure encounter E1/); // stays stopped on later checks
      assert.equal((await uploadsJson()).uploads.E1.status, "started");

      // A person checks the chart: it's not there. eCW works again.
      mock.setFailUploads(false);
      const resolved = await runNode("ecw-resolve.js", env, ["E1", "--retry"]);
      assert.equal(resolved.code, 0, resolved.out);

      await waitFor(/E1 was checked by a person \(set to be tried again\) — uploading again/);
      await waitFor(/E3 \(signed 2026-10-26\): uploaded/);
      await waitFor(/E1 \(signed 2026-10-26\): uploaded/);
      assert.equal(mock.state.logins, 1); // the browser was kept: no second login or email
      assert.equal(mock.state.emailsSent, 1);
    } finally {
      if (child.exitCode === null) {
        const closed = new Promise((r) => child.once("close", r));
        child.kill();
        await closed;
      }
    }
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
