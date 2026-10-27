// Runs the real ecw-check.js command against the fake eCW, with made-up PDFs
// and a manifest in a temp folder. Environment variables point it there:
// it never reads .env and can't reach the real eCW.
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

describe("ecw-check.js against the fake eCW", { timeout: 180_000 }, () => {
  let mock, tmp, stateDir, outputDir, env;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ecw-check-test-"));
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
    return file;
  };

  const readReport = async () =>
    JSON.parse(
      await fs.readFile(path.join(stateDir, `ecw-check-${DAY}.json`), "utf8"),
    );

  it("gives every encounter the right result, logs in once, and changes nothing in eCW", async () => {
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
    );
    await exported(
      "E3",
      "GM999999",
      "TestlastzPatz_DOB05.06.1950_DOS10.12.2026.pdf",
    );
    await exported(
      "E4",
      "GM100001",
      "TestlastaPata_DOB02.02.1940_DOS10.12.2026.pdf",
    );
    await exported(
      "E5",
      "GM100003",
      "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf",
    );
    await fs.rm(
      await exported(
        "E6",
        "GM100001",
        "TestlastaPata_DOB01.02.1940_DOS10.12.2026_2.pdf",
      ),
    );

    const { code, out } = await runNode("ecw-check.js", envFor(), [
      "--date",
      DAY,
    ]);
    assert.equal(code, 0, out);

    const report = await readReport();
    const byId = Object.fromEntries(
      report.results.map((r) => [r.encounterId, r]),
    );
    assert.equal(byId.E1.result, "match");
    assert.equal(byId.E2.result, "several");
    assert.equal(byId.E3.result, "not-found");
    assert.equal(byId.E4.result, "mismatch");
    assert.match(byId.E4.reason, /DOB/);
    assert.equal(byId.E5.result, "match");
    assert.equal(byId.E6.result, "problem");
    assert.deepEqual(report.summary, {
      match: 2,
      "not-found": 1,
      several: 1,
      mismatch: 1,
      problem: 1,
      error: 0,
    });

    assert.equal(mock.state.logins, 1);
    assert.equal(mock.state.emailsSent, 1);
    assert.equal(mock.state.deletes, 0);
  });

  it("puts no names or dates of birth in the report or the output", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );
    await exported(
      "E4",
      "GM100001",
      "TestlastaPata_DOB02.02.1940_DOS10.12.2026.pdf",
    );

    const { out } = await runNode("ecw-check.js", envFor(), ["--date", DAY]);
    const reportText = await fs.readFile(
      path.join(stateDir, `ecw-check-${DAY}.json`),
      "utf8",
    );
    for (const text of [out, reportText]) {
      assert.doesNotMatch(text, /testlast|pata/i);
      assert.doesNotMatch(text, /1940/);
    }
  });

  it("stops after ONE failed sign-in, without trying again", async () => {
    mock = await startMockEcw({ requireLogin: true });
    await exported(
      "E1",
      "GM100001",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    );
    await exported(
      "E2",
      "GM100002",
      "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf",
    );

    const { code, out } = await runNode(
      "ecw-check.js",
      envFor({ ECW_PASSWORD: "wrong" }),
      ["--date", DAY],
    );
    assert.equal(code, 1);
    assert.match(out, /sign-in failed/);
    assert.equal(mock.state.failedLogins, 1);
    assert.equal(mock.state.searches.length, 0);
  });

  it("doesn't log in at all when there's nothing it can search", async () => {
    mock = await startMockEcw({ requireLogin: true });
    await fs.rm(
      await exported(
        "E1",
        "GM100001",
        "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
      ),
    );

    const { code } = await runNode("ecw-check.js", envFor(), ["--date", DAY]);
    assert.equal(code, 0);
    assert.equal(mock.state.logins, 0);
    assert.equal((await readReport()).summary.problem, 1);
  });

  it("--limit checks only the first N", async () => {
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
    );
    await exported(
      "E3",
      "GM999999",
      "TestlastzPatz_DOB05.06.1950_DOS10.12.2026.pdf",
    );

    await runNode("ecw-check.js", envFor(), ["--date", DAY, "--limit", "1"]);
    assert.deepEqual(
      (await readReport()).results.map((r) => r.encounterId),
      ["E1"],
    );
  });
});
