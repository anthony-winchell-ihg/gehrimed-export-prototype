import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendManifest, sha256File } from "../manifest.js";
import { encountersToCheck } from "./checkList.js";

const DAY = "2026-10-13";

describe("encountersToCheck", () => {
  let dir, outputDir, manifestFile;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "checklist-test-"));
    outputDir = path.join(dir, "output");
    manifestFile = path.join(dir, "manifest.jsonl");
    await fs.mkdir(path.join(outputDir, DAY), { recursive: true });
  });

  /** Saves a made-up "PDF" in the day folder and its manifest line, like the export does. */
  const exported = async ({
    encounterId,
    patientId = "GM100001",
    fileName,
    dateOfService = "2026-10-12",
    day = DAY,
  }) => {
    const file = path.join(outputDir, day, fileName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `fake pdf for ${encounterId}`); // different content = different hash
    const sha256 = await sha256File(file);
    await appendManifest(manifestFile, [
      { encounterId, patientId, dateOfService, signedOn: day, sha256 },
    ]);
    return file;
  };

  it("lists each exported encounter with its External MRN, last name and DOB", async () => {
    await exported({
      encounterId: "E1",
      fileName: "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    });
    const [item] = await encountersToCheck({
      manifestFile,
      outputDir,
      day: DAY,
    });
    assert.equal(item.encounterId, "E1");
    assert.equal(item.externalMrn, "GM100001");
    assert.equal(item.expected.lastName, "Testlasta");
    assert.equal(item.expected.dateOfBirth.toISODate(), "1940-01-02");
    assert.equal(item.problem, undefined);
  });

  it("only lists encounters signed on the requested day", async () => {
    await exported({
      encounterId: "E1",
      fileName: "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    });
    await exported({
      encounterId: "E2",
      fileName: "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf",
      day: "2026-10-14",
    });
    const items = await encountersToCheck({
      manifestFile,
      outputDir,
      day: DAY,
    });
    assert.deepEqual(
      items.map((i) => i.encounterId),
      ["E1"],
    );
  });

  it("still finds a PDF billing renamed to another valid name — it goes by content, not name", async () => {
    const file = await exported({
      encounterId: "E1",
      fileName: "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    });
    await fs.rename(
      file,
      path.join(
        path.dirname(file),
        "TestlastaPata_DOB01.02.1940_DOS10.12.2026_2.pdf",
      ),
    );
    const [item] = await encountersToCheck({
      manifestFile,
      outputDir,
      day: DAY,
    });
    assert.equal(item.problem, undefined);
  });

  it("reports, never guesses: missing PDF, renamed out of format, wrong date, no patient ID", async () => {
    const gone = await exported({
      encounterId: "E1",
      fileName: "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    });
    await fs.rm(gone);
    const renamed = await exported({
      encounterId: "E2",
      fileName: "TestlastbPatb_DOB02.03.1941_DOS10.12.2026.pdf",
    });
    await fs.rename(renamed, path.join(path.dirname(renamed), "scan0001.pdf"));
    await exported({
      encounterId: "E3",
      fileName: "TestlastcPatc_DOB03.04.1942_DOS10.11.2026.pdf",
    }); // record says 10/12
    await exported({
      encounterId: "E4",
      patientId: null,
      fileName: "TestlastdPatd_DOB04.05.1943_DOS10.12.2026.pdf",
    });

    const problems = Object.fromEntries(
      (await encountersToCheck({ manifestFile, outputDir, day: DAY })).map(
        (i) => [i.encounterId, i.problem],
      ),
    );
    assert.match(problems.E1, /not found/);
    assert.match(problems.E2, /not in the expected format/);
    assert.match(problems.E3, /date of service doesn't match/);
    assert.match(problems.E4, /no GEHRIMed patient ID/);
  });

  it("copes with a day folder that's gone (e.g. deleted after 7 days)", async () => {
    await exported({
      encounterId: "E1",
      fileName: "TestlastaPata_DOB01.02.1940_DOS10.12.2026.pdf",
    });
    await fs.rm(path.join(outputDir, DAY), { recursive: true });
    const [item] = await encountersToCheck({
      manifestFile,
      outputDir,
      day: DAY,
    });
    assert.match(item.problem, /not found/);
  });
});
