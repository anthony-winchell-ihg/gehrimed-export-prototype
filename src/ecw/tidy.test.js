import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendManifest, sha256File } from "../manifest.js";
import { stagePdf } from "../staging.js";
import { loadUploads } from "../uploads.js";
import { describeTidy, tidyUploaded } from "./tidy.js";

const DAY = "2026-10-28";

describe("tidyUploaded", () => {
  let dir, outputDir, stagingDir, manifestFile, uploads;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tidy-test-"));
    outputDir = path.join(dir, "output");
    stagingDir = path.join(dir, "staging");
    manifestFile = path.join(dir, "manifest.jsonl");
    uploads = await loadUploads(path.join(dir, "uploads.json"));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  /** A made-up PDF in the Teams day folder, staged, with its manifest line — like the export. */
  const exported = async (encounterId, fileName, day = DAY) => {
    const file = path.join(outputDir, day, fileName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `fake pdf for ${encounterId}`);
    const sha256 = await sha256File(file);
    await stagePdf(stagingDir, file, sha256, { encounterId, lastName: "Testlast", dateOfBirth: "1940-01-02", dateOfService: "2026-10-12" });
    await appendManifest(manifestFile, [{ encounterId, patientId: "GM100001", dateOfService: "2026-10-12", signedOn: day, sha256 }]);
    return file;
  };
  const tidy = (days = [DAY]) => tidyUploaded({ manifestFile, outputDir, stagingDir, days, uploads });
  const ls = (...p) => fs.readdir(path.join(...p)).then((n) => n.sort(), () => []);

  it("moves uploaded PDFs into <day>\\Uploaded\\ and deletes their staged copies; leaves the rest alone", async () => {
    await exported("E1", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf");
    await exported("E2", "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf"); // on the manual list
    await exported("E3", "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf"); // not handled yet
    await uploads.markUploaded("E1", "2026-10-12");
    await uploads.markNeedsManual("E2", "mismatch: last name differs");

    assert.deepEqual(await tidy(), { moved: 1, unstaged: 1, notMoved: 0 });
    assert.deepEqual(await ls(outputDir, DAY, "Uploaded"), ["TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf"]);
    assert.deepEqual(await ls(outputDir, DAY), [
      "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf",
      "TestlastcPatc_DOB03.04.1942_DOS10.12.2026.pdf",
      "Uploaded",
    ]);
    assert.equal((await ls(stagingDir)).length, 4); // E2 and E3 keep theirs (pdf + json each)
  });

  it("tidies an encounter a person marked uploaded with ecw-resolve", async () => {
    await exported("E1", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf");
    await uploads.markStarted("E1", "2026-10-12");
    assert.equal((await tidy()).moved, 0); // "started" isn't uploaded
    await uploads.resolve("E1", "uploaded");
    assert.equal((await tidy()).moved, 1);
  });

  it("never overwrites a file already in Uploaded\\ — same name gets _2", async () => {
    const file = await exported("E1", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf");
    await fs.mkdir(path.join(path.dirname(file), "Uploaded"));
    await fs.writeFile(path.join(path.dirname(file), "Uploaded", path.basename(file)), "another note");
    await uploads.markUploaded("E1", "2026-10-12");
    await tidy();
    assert.deepEqual(await ls(outputDir, DAY, "Uploaded"), [
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
      "TestlastaPata_DOB01.02.1940_DOS10.12.2026_2.pdf",
    ]);
    assert.equal(await fs.readFile(path.join(outputDir, DAY, "Uploaded", path.basename(file)), "utf8"), "another note");
  });

  it("is safe to run again, and copes with PDFs billing already moved or renamed", async () => {
    const file = await exported("E1", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf");
    const renamed = await exported("E2", "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf");
    await fs.rm(file); // billing took it
    await fs.rename(renamed, path.join(path.dirname(renamed), "scan0001.pdf")); // found by content, not name
    await uploads.markUploaded("E1", "2026-10-12");
    await uploads.markUploaded("E2", "2026-10-12");
    assert.deepEqual(await tidy(), { moved: 1, unstaged: 2, notMoved: 0 });
    assert.deepEqual(await ls(outputDir, DAY, "Uploaded"), ["scan0001.pdf"]);
    assert.deepEqual(await tidy(), { moved: 0, unstaged: 0, notMoved: 0 });
  });

  it("only looks at the days it's given", async () => {
    await exported("E1", "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf", "2026-10-27");
    await uploads.markUploaded("E1", "2026-10-12");
    assert.deepEqual(await tidy([DAY]), { moved: 0, unstaged: 0, notMoved: 0 });
  });

  it("describes what it did in one line, or nothing", () => {
    assert.equal(describeTidy({ moved: 0, notMoved: 0 }), "");
    assert.match(describeTidy({ moved: 2, notMoved: 1 }), /Moved 2 uploaded PDF\(s\) into Uploaded\\ · .*1 uploaded PDF\(s\) couldn't be moved/);
  });
});
