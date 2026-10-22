// Runs the real commands (run.js and watch.js) against the fake GEHRIMed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPdf } from "../src/archive/sevenZip.js";
import { isEncryptedPdf } from "../src/archive/pdf.js";
import { readManifest, sha256File } from "../src/manifest.js";
import {
  MOCK_DAYS,
  MOCK_LOGIN,
  expectedNames,
  mockPatient,
  startMock,
} from "./mock-gehrimed.js";

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

const listPdfs = async (dir) =>
  (await fs.readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".pdf"))
    .sort();

for (const mode of ["pdf", "zip"]) {
  describe(
    `run.js against mock GEHRIMed (download = password-protected ${mode})`,
    { timeout: 240_000 },
    () => {
      let mock, tmp, env;
      before(async () => {
        mock = await startMock({ download: mode, requireLogin: true });
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "export-test-"));
        env = {
          GEHRIMED_URL: mock.url,
          GEHRIMED_USERNAME: MOCK_LOGIN.username,
          GEHRIMED_PASSWORD: MOCK_LOGIN.password,
          OUTPUT_DIR: path.join(tmp, "out"),
          STATE_FILE: path.join(tmp, "state.json"),
        };
      });
      after(async () => {
        await mock.close();
        await fs.rm(tmp, { recursive: true, force: true });
      });

      if (mode === "pdf") {
        it("exports every result past page 1 into the day folder, unlocked and named for billing — never clicking Resend", async () => {
          const day = "2026-10-13";
          const { code, out } = await runNode("run.js", env, [
            "--headless",
            "--date",
            day,
            "--limit",
            "0",
          ]);
          assert.equal(code, 0, out);
          assert.match(out, /setting Per Page to 500/);
          assert.equal(mock.state.downloads, MOCK_DAYS[day].length);
          assert.equal(mock.state.resends, 0, "Resend must never be clicked");

          const dayDir = path.join(env.OUTPUT_DIR, day);
          const files = await listPdfs(dayDir);
          assert.deepEqual(files, expectedNames(day).sort());
          assert.ok(
            files.includes("TestlastdPatd_DOB04.04.1940_DOS10.12.2026_2.pdf"),
            "same patient + DOS gets _2",
          );
          for (const f of files) {
            assert.equal(await isPdf(path.join(dayDir, f)), true);
            assert.equal(
              await isEncryptedPdf(path.join(dayDir, f)),
              false,
              "PDFs must not be password-protected",
            );
          }
          const leftovers = (await fs.readdir(dayDir)).filter(
            (f) => !f.endsWith(".pdf"),
          );
          assert.deepEqual(
            leftovers,
            [],
            "no temporary files left in the folder",
          );

          // The state file records IDs only — no patient names.
          const state = await fs.readFile(env.STATE_FILE, "utf8");
          assert.doesNotMatch(state, /PAT[A-Z]|TESTLAST|Testlast/);
          assert.equal(
            Object.keys(JSON.parse(state).exported).length,
            MOCK_DAYS[day].length,
          );

          // Manifest: one line per PDF with the IDs step 2 needs; each sha256 matches a file in the folder.
          const stateDir = path.dirname(env.STATE_FILE);
          const manifest = await readManifest(
            path.join(stateDir, "manifest.jsonl"),
          );
          assert.equal(manifest.length, MOCK_DAYS[day].length);
          assert.deepEqual(
            manifest.map((m) => m.encounterId),
            MOCK_DAYS[day],
          );
          assert.deepEqual(manifest[0], {
            ...manifest[0],
            patientId: "100000",
            dateOfService: "2026-10-12",
            signedOn: day,
          });
          const hashes = new Set(
            await Promise.all(
              files.map((f) => sha256File(path.join(dayDir, f))),
            ),
          );
          assert.ok(
            manifest.every((m) => hashes.has(m.sha256)),
            "every manifest hash matches a saved PDF",
          );
          assert.doesNotMatch(
            await fs.readFile(path.join(stateDir, "manifest.jsonl"), "utf8"),
            /PAT[A-Z]|TESTLAST|Testlast/,
          );

          // Ledger: the day's counts, no names or IDs.
          const ledgerText = await fs.readFile(
            path.join(stateDir, "ledger.json"),
            "utf8",
          );
          const entry = JSON.parse(ledgerText).days[day];
          assert.equal(entry.signed, 25);
          assert.equal(entry.exported, 25);
          assert.equal(entry.notShown, 0);
          assert.doesNotMatch(ledgerText, /9000001|PAT[A-Z]/);
        });

        it("running the same day again downloads nothing new", async () => {
          const before = mock.state.downloads;
          const { code, out } = await runNode("run.js", env, [
            "--headless",
            "--date",
            "2026-10-13",
            "--limit",
            "0",
          ]);
          assert.equal(code, 0, out);
          assert.match(out, /already exported 25 · saved 0/);
          assert.equal(mock.state.downloads, before);
        });
        it("skips test patients, and one unnameable row doesn't stop the others", async () => {
          const day = "2026-10-14"; // normal, test patient, no first name, normal
          const { code, out } = await runNode("run.js", env, [
            "--headless",
            "--date",
            day,
            "--limit",
            "0",
          ]);
          assert.equal(code, 1, "a failed encounter makes the run exit 1");
          assert.match(
            out,
            /Found 4 · already exported 0 · saved 2 · failed 1 · test patients skipped 1/,
          );
          assert.match(
            out,
            /900000203 \(attempt 1\/5\): Can't build file name — missing\/unreadable: first name/,
          );
          assert.equal(
            (await listPdfs(path.join(env.OUTPUT_DIR, day))).length,
            2,
          );
          assert.equal(
            (out.match(/📸/g) ?? []).length,
            1,
            "one snapshot per run, not one per failure",
          );
        });

        it("stops a day after 5 failures in a row instead of failing every row", async () => {
          const { code, out } = await runNode("run.js", env, [
            "--headless",
            "--date",
            "2026-10-15",
            "--limit",
            "0",
          ]);
          assert.equal(code, 1);
          assert.match(
            out,
            /5 encounters in a row failed for 2026-10-15 — stopping this day/,
          );
          assert.equal((out.match(/❌ 2026-10-15/g) ?? []).length, 5);
        });
      } else {
        it("handles an encrypted zip containing a password-protected PDF, and respects --limit", async () => {
          const day = "2026-10-13";
          const { code, out } = await runNode("run.js", env, [
            "--headless",
            "--date",
            day,
            "--limit",
            "2",
          ]);
          assert.equal(code, 0, out);
          assert.equal(mock.state.downloads, 2);
          const files = await listPdfs(path.join(env.OUTPUT_DIR, day));
          assert.deepEqual(files, expectedNames(day).slice(0, 2).sort());
        });
      }
    },
  );
}

describe(
  "results that don't all fit on GEHRIMed's results page",
  { timeout: 240_000 },
  () => {
    let mock, tmp, env;
    before(async () => {
      mock = await startMock({ requireLogin: true, rowCap: 20 }); // 25 signed, only 20 shown
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cap-test-"));
      env = {
        GEHRIMED_URL: mock.url,
        GEHRIMED_USERNAME: MOCK_LOGIN.username,
        GEHRIMED_PASSWORD: MOCK_LOGIN.password,
        OUTPUT_DIR: path.join(tmp, "out"),
        STATE_FILE: path.join(tmp, "state.json"),
        LOG_DIR: path.join(tmp, "logs"),
      };
    });
    after(async () => {
      await mock.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it("run.js exports what it can, then reports the missing ones and exits 1", async () => {
      const { code, out } = await runNode("run.js", env, [
        "--headless",
        "--date",
        "2026-10-13",
        "--limit",
        "0",
      ]);
      assert.equal(code, 1, out);
      assert.match(out, /only 20 are on the results page — 5 can't be reached/);
      assert.match(out, /saved 20 · failed 0 · NOT on the results page 5/);
      const ledger = JSON.parse(
        await fs.readFile(path.join(tmp, "ledger.json"), "utf8"),
      );
      assert.equal(ledger.days["2026-10-13"].notShown, 5);
    });

    it("watch.js does not mark the day complete, and says it needs a look", async () => {
      const { code, out } = await runNode("watch.js", env, [
        "--once",
        "--today",
        "2026-10-14",
      ]);
      assert.match(
        out,
        /2026-10-13: 25 signed · 20 already exported · 0 new saved · 5 NOT on the results page/,
      );
      assert.match(
        out,
        /⚠️ {2}2026-10-13 needs a look: 5 not on the results page/,
      );
      const state = JSON.parse(await fs.readFile(env.STATE_FILE, "utf8"));
      assert.equal(
        state.lastCompletedDay,
        undefined,
        "a day with unreachable notes must be checked again",
      );
      assert.equal(code, 1, out); // 10-14 has a broken row too
    });
  },
);

describe("watch.js against mock GEHRIMed", { timeout: 300_000 }, () => {
  let mock, tmp, env;
  const watchOnce = () =>
    runNode("watch.js", env, ["--once", "--today", "2026-10-13"]);
  before(async () => {
    mock = await startMock({ requireLogin: true });
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "watch-test-"));
    env = {
      GEHRIMED_URL: mock.url,
      GEHRIMED_USERNAME: MOCK_LOGIN.username,
      GEHRIMED_PASSWORD: MOCK_LOGIN.password,
      OUTPUT_DIR: path.join(tmp, "out"),
      STATE_FILE: path.join(tmp, "state.json"),
      LOG_DIR: path.join(tmp, "logs"),
    };
  });
  after(async () => {
    await mock.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes a timestamped daily log file — with IDs and counts, no patient names", async () => {
    const { code, out } = await runNode("watch.js", env, [
      "--once",
      "--today",
      "2026-10-18",
    ]);
    assert.equal(code, 0, out);
    const files = await fs.readdir(env.LOG_DIR);
    assert.equal(files.length, 1);
    assert.match(files[0], /^watch-\d{4}-\d{2}-\d{2}\.log$/);
    const log = await fs.readFile(path.join(env.LOG_DIR, files[0]), "utf8");
    assert.match(log, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /m);
    assert.match(
      log,
      /2026-10-18: 1 signed · 0 already exported · 1 new saved/,
    );
    assert.match(log, /✅ 2026-10-18 900000001/);
    assert.doesNotMatch(log, /TESTLAST|Testlast|PAT[A-Z]\b/);
  });

  it("first check exports today's and yesterday's signed encounters (and clears folders 7+ days old)", async () => {
    // Folders from before the retention window, plus one that must survive.
    for (const d of ["2026-10-01", "2026-10-06", "2026-10-07"]) {
      await fs.mkdir(path.join(env.OUTPUT_DIR, d), { recursive: true });
      await fs.writeFile(path.join(env.OUTPUT_DIR, d, "old.pdf"), "x");
    }
    const { code, out } = await watchOnce();
    assert.equal(code, 0, out);
    assert.match(out, /Deleted 2 old day folder\(s\): 2026-10-01, 2026-10-06/);
    const folders = (await fs.readdir(env.OUTPUT_DIR)).sort();
    // 10-07 is 6 days before 10-13: kept. 10-18 (from the log test) is newer: kept.
    assert.deepEqual(folders, ["2026-10-07", "2026-10-13", "2026-10-18"]);
    assert.match(out, /2026-10-12: 0 signed/);
    assert.match(out, /2026-10-12 needs a look: 0 signed on a weekday/); // a Monday — holiday, or a broken search?
    assert.match(
      out,
      /2026-10-13: 25 signed · 0 already exported · 25 new saved/,
    );
    assert.equal(
      (await listPdfs(path.join(env.OUTPUT_DIR, "2026-10-13"))).length,
      25,
    );
  });

  it("next check with nothing new downloads nothing", async () => {
    const before = mock.state.downloads;
    const { code, out } = await watchOnce();
    assert.equal(code, 0, out);
    assert.match(
      out,
      /2026-10-13: 25 signed · 25 already exported · 0 new saved/,
    );
    assert.equal(mock.state.downloads, before);
  });

  it("a newly signed note shows up on the next check — and only that one is downloaded", async () => {
    mock.addEncounter("2026-10-13", "900000999");
    const before = mock.state.downloads;
    const { code, out } = await watchOnce();
    assert.equal(code, 0, out);
    assert.match(
      out,
      /2026-10-13: 26 signed · 25 already exported · 1 new saved/,
    );
    assert.equal(mock.state.downloads, before + 1);

    const files = await listPdfs(path.join(env.OUTPUT_DIR, "2026-10-13"));
    assert.equal(files.length, 26);
    assert.ok(
      files.some((f) => f.startsWith("TestlastzPatz")),
      `expected a file for ${mockPatient(25).firstName}`,
    );
  });
});
