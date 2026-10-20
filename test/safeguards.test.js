// The safeguards added after the pre-pilot review.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_LOGIN, startMock } from "./mock-gehrimed.js";

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

const setup = async (mockOptions = {}, envOverrides = {}) => {
  const mock = await startMock({ requireLogin: true, ...mockOptions });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "safeguard-test-"));
  const env = {
    GEHRIMED_URL: mock.url,
    GEHRIMED_USERNAME: MOCK_LOGIN.username,
    GEHRIMED_PASSWORD: MOCK_LOGIN.password,
    OUTPUT_DIR: path.join(tmp, "out"),
    STATE_FILE: path.join(tmp, "state", "exported.json"),
    LOG_DIR: path.join(tmp, "logs"),
    ...envOverrides,
  };
  const close = async () => {
    await mock.close();
    await fs.rm(tmp, { recursive: true, force: true });
  };
  return { mock, tmp, env, close };
};

describe("safeguards", { timeout: 300_000 }, () => {
  it("refuses to save a PDF when the download prompt is for a different encounter", async () => {
    const t = await setup({ wrongPromptFor: "900000001" });
    try {
      const { code, out } = await runNode("run.js", t.env, ["--headless", "--date", "2026-10-18", "--limit", "0"]);
      assert.equal(code, 1, out);
      assert.match(out, /Download prompt is for encounter 999999999, not 900000001 — stopped to avoid a misnamed file/);
      assert.equal(t.mock.state.downloads, 0, "nothing was downloaded");
      const files = await fs.readdir(path.join(t.env.OUTPUT_DIR, "2026-10-18")).catch(() => []);
      assert.deepEqual(files, []);
    } finally {
      await t.close();
    }
  });

  it("only one export at a time: a second one exits with code 3", async () => {
    const t = await setup();
    try {
      // Pretend this test process is a running export holding the lock.
      const lockFile = path.join(path.dirname(t.env.STATE_FILE), "export.lock");
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, label: "watch", since: "earlier" }));
      const { code, out } = await runNode("run.js", t.env, ["--headless", "--date", "2026-10-18"]);
      assert.equal(code, 3, out);
      assert.match(out, /Another export is already running \(watch/);
      assert.equal(t.mock.state.logins, 0, "didn't even log in");
    } finally {
      await t.close();
    }
  });

  it("a lock left by a process that no longer exists is taken over", async () => {
    const t = await setup();
    try {
      const lockFile = path.join(path.dirname(t.env.STATE_FILE), "export.lock");
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ pid: 999_999_99, label: "watch", since: "a crash" }));
      const { code, out } = await runNode("run.js", t.env, ["--headless", "--date", "2026-10-18"]);
      assert.equal(code, 0, out);
    } finally {
      await t.close();
    }
  });

  it("after a failed sign-in, watch mode stops logging in (so the account isn't locked)", async () => {
    const t = await setup({}, { GEHRIMED_PASSWORD: "Wrong#Pass1" });
    try {
      const { out } = await runNode("watch.js", t.env, ["--once", "--today", "2026-10-13"]);
      assert.match(out, /Netsmart sign-in failed: Unable to sign in/);
      assert.match(out, /Sign-in problem — stopping automatic logins/);
      assert.equal(t.mock.state.failedLogins, 1, "tried exactly once");
      assert.doesNotMatch(out, /Wrong#Pass1/, "never prints the password");
    } finally {
      await t.close();
    }
  });

  it("after downtime, catches up on every day since the last completed check", async () => {
    const t = await setup();
    try {
      await fs.mkdir(path.dirname(t.env.STATE_FILE), { recursive: true });
      await fs.writeFile(t.env.STATE_FILE, JSON.stringify({ version: 1, exported: {}, failures: {}, lastCompletedDay: "2026-10-10" }));
      const { code, out } = await runNode("watch.js", t.env, ["--once", "--today", "2026-10-13"]);
      assert.equal(code, 0, out);
      assert.match(out, /Catching up on 4 days \(2026-10-10 → today\)/);
      for (const d of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]) assert.match(out, new RegExp(`${d}: \\d+ signed`));
      const state = JSON.parse(await fs.readFile(t.env.STATE_FILE, "utf8"));
      assert.equal(state.lastCompletedDay, "2026-10-12", "everything before today is now marked done");
    } finally {
      await t.close();
    }
  });
});
