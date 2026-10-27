// Runs the real ecw-upload.js command against the fake eCW, with made-up PDFs
// and a manifest in a temp folder. Environment variables point it there: it
// never reads .env and can't reach the real eCW.
// (Confirm mode needs a person at a visible window; it's covered in ecw-upload.test.js.)
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
const DAY = "2026-10-13";

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

describe("ecw-upload.js against the fake eCW", { timeout: 240_000 }, () => {
  let mock, tmp, stateDir, outputDir;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecw-upload-cmd-test-"));
    stateDir = path.join(tmp, "state");
    outputDir = path.join(tmp, "output");
    await fs.mkdir(path.join(outputDir, DAY), { recursive: true });
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
    ...overrides,
  });
  const automatic = (overrides = {}) =>
    envFor({ ECW_AUTOMATIC_UPLOADS: "on", ...overrides });
  const run = (env, ...args) =>
    runNode("ecw-upload.js", env, ["--date", DAY, ...args]);

  /** A made-up PDF in the day folder plus its manifest line, like the export writes. */
  const exported = async (encounterId, patientId, fileName) => {
    const file = path.join(outputDir, DAY, fileName);
    await fs.writeFile(file, `fake pdf for ${encounterId}`);
    await appendManifest(path.join(stateDir, "manifest.jsonl"), [
      {
        encounterId,
        patientId,
        dateOfService: "2026-10-12",
        signedOn: DAY,
        sha256: await sha256File(file),
      },
    ]);
  };
  const uploadsJson = async () =>
    JSON.parse(await fs.readFile(path.join(stateDir, "uploads.json"), "utf8"));
  const report = async (mode) =>
    JSON.parse(
      await fs.readFile(
        path.join(stateDir, `ecw-upload-${DAY}-${mode}.json`),
        "utf8",
      ),
    );

  it("check mode goes all the way to Chart Documents but uploads and records nothing", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );
    await exported(
      "E2",
      "GM100002",
      "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf",
    ); // two charts

    const { code, out } = await run(envFor());
    assert.equal(code, 0, out);
    const byId = Object.fromEntries(
      (await report("check")).results.map((r) => [r.encounterId, r.result]),
    );
    assert.deepEqual(byId, { E1: "ready", E2: "manual" });
    assert.equal(mock.state.uploads.length, 0);
    await assert.rejects(() => fs.access(path.join(stateDir, "uploads.json"))); // nothing recorded
  });

  it("refuses upload mode without ECW_AUTOMATIC_UPLOADS=on, before logging in", async () => {
    mock = await startMockEcw({ requireLogin: true });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );
    const { code, out } = await run(
      envFor(),
      "--mode",
      "upload",
      "--encounter",
      "E1",
    );
    assert.equal(code, 2);
    assert.match(out, /ECW_AUTOMATIC_UPLOADS=on/);
    assert.equal(mock.state.logins, 0);
  });

  it("refuses upload mode without --encounter", async () => {
    mock = await startMockEcw({ requireLogin: true });
    const { code, out } = await run(automatic(), "--mode", "upload");
    assert.equal(code, 2);
    assert.match(out, /--encounter/);
  });

  it("uploads a named encounter once — and never again on the next run", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );
    await exported(
      "E3",
      "GM100003",
      "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf",
    ); // not named: left alone

    const first = await run(
      automatic(),
      "--mode",
      "upload",
      "--encounter",
      "E1",
    );
    assert.equal(first.code, 0, first.out);
    assert.deepEqual(
      mock.state.uploads.map((u) => [u.externalMrn, u.catid, u.customName]),
      [["GM100001", 2, "2026-10-12 Progress Note"]],
    );
    assert.equal((await uploadsJson()).uploads.E1.status, "uploaded");

    const second = await run(
      automatic(),
      "--mode",
      "upload",
      "--encounter",
      "E1",
    );
    assert.match(second.out, /E1: skipped/);
    assert.equal(mock.state.uploads.length, 1);
  });

  it("puts a chart eCW asks about on the manual list, without answering or uploading", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported(
      "E4",
      "GM100004",
      "TestlastdPatd_DOB04.05.1943_DOS10.12.2026.pdf",
    ); // partially merged

    const { out } = await run(
      automatic(),
      "--mode",
      "upload",
      "--encounter",
      "E4",
    );
    assert.match(out, /E4: manual/);
    assert.equal((await uploadsJson()).uploads.E4.status, "manual");
    assert.equal(mock.state.uploads.length, 0);
    assert.equal(mock.state.promptsAnsweredYes, 0);
  });

  it("stops when it can't tell whether an upload worked, and never retries it by itself", async () => {
    mock = await startMockEcw({
      requireLogin: true,
      confirmEmailAfterMs: 500,
      failUploads: true,
    });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );

    const first = await run(
      automatic(),
      "--mode",
      "upload",
      "--encounter",
      "E1",
    );
    assert.equal(first.code, 1);
    assert.match(first.out, /E1: uncertain/);
    assert.equal((await uploadsJson()).uploads.E1.status, "started"); // on the manual list
    assert.match(first.out, /may already be there/);

    const second = await run(
      automatic(),
      "--mode",
      "upload",
      "--encounter",
      "E1",
    );
    assert.match(second.out, /E1: skipped/);
  });

  it("puts no names or dates of birth in the output, the report or uploads.json", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );
    await exported(
      "E4",
      "GM100004",
      "TestlastdPatd_DOB04.05.1943_DOS10.12.2026.pdf",
    );

    const { out } = await run(
      automatic(),
      "--mode",
      "upload",
      "--encounter",
      "E1",
      "--encounter",
      "E4",
    );
    const files = [
      await fs.readFile(
        path.join(stateDir, `ecw-upload-${DAY}-upload.json`),
        "utf8",
      ),
      await fs.readFile(path.join(stateDir, "uploads.json"), "utf8"),
    ];
    for (const text of [out, ...files]) {
      assert.doesNotMatch(text, /testlast|pata|patd/i);
      assert.doesNotMatch(text, /1940|1943/);
    }
  });
});
