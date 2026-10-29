import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256File } from "./manifest.js";
import { readStaged, stagePdf, unstage } from "./staging.js";

// Made-up patient. Tests never use real patient data.
const DETAILS = {
  encounterId: "E1",
  lastName: "Testlast Jr.",
  dateOfBirth: "1940-01-02",
  dateOfService: "2026-10-12",
};

describe("staging", () => {
  let dir, stagingDir, pdf, sha;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "staging-test-"));
    stagingDir = path.join(dir, "staging");
    pdf = path.join(dir, "note.pdf");
    await fs.writeFile(pdf, "%PDF-1.4 made-up note");
    sha = await sha256File(pdf);
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it("keeps a byte-for-byte copy with the last name exactly as GEHRIMed shows it", async () => {
    await stagePdf(stagingDir, pdf, sha, DETAILS);
    const staged = await readStaged(stagingDir, sha);
    assert.equal(await sha256File(staged.pdfPath), sha);
    assert.equal(staged.lastName, "Testlast Jr.");
    assert.equal(staged.dateOfBirth.toISODate(), "1940-01-02");
    assert.deepEqual([staged.encounterId, staged.dateOfService], ["E1", "2026-10-12"]);
    assert.deepEqual((await fs.readdir(stagingDir)).sort(), [`${sha}.json`, `${sha}.pdf`]); // no temp files left
  });

  it("reads as nothing staged when there's no copy, or only half of one", async () => {
    assert.equal(await readStaged(stagingDir, sha), null);
    await stagePdf(stagingDir, pdf, sha, DETAILS);
    await fs.rm(path.join(stagingDir, `${sha}.pdf`));
    assert.equal(await readStaged(stagingDir, sha), null);
  });

  it("reports a changed copy or incomplete details instead of using them", async () => {
    await stagePdf(stagingDir, pdf, sha, DETAILS);
    await fs.appendFile(path.join(stagingDir, `${sha}.pdf`), "changed");
    assert.match((await readStaged(stagingDir, sha)).problem, /changed/);

    await stagePdf(stagingDir, pdf, sha, { ...DETAILS, dateOfBirth: null });
    assert.match((await readStaged(stagingDir, sha)).problem, /incomplete/);

    await fs.writeFile(path.join(stagingDir, `${sha}.json`), "{ not json");
    assert.match((await readStaged(stagingDir, sha)).problem, /can't be read/);
  });

  it("unstage deletes both files, and says whether there was a copy", async () => {
    await stagePdf(stagingDir, pdf, sha, DETAILS);
    assert.equal(await unstage(stagingDir, sha), true);
    assert.deepEqual(await fs.readdir(stagingDir), []);
    assert.equal(await unstage(stagingDir, sha), false);
  });
});
