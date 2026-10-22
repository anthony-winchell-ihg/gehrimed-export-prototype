// Round-trip test: zip a fake PDF with a password, then extract it again.
// No GEHRIMed or patient data involved.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractPdfs, isPdf, zipFolder } from "./sevenZip.js";

describe("sevenZip", () => {
  let dir;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sevenzip-test-"));
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(
      path.join(dir, "src", "note.pdf"),
      "%PDF-1.7\nfake test pdf\n",
    );
    await fs.writeFile(path.join(dir, "src", "readme.txt"), "not a pdf");
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  it("isPdf recognizes the PDF signature", async () => {
    assert.equal(await isPdf(path.join(dir, "src", "note.pdf")), true);
    assert.equal(await isPdf(path.join(dir, "src", "readme.txt")), false);
  });

  it("round-trips an encrypted zip and returns only the PDFs", async () => {
    const zip = path.join(dir, "out.zip");
    await zipFolder(path.join(dir, "src"), zip, "Test#Pass9");
    const pdfs = await extractPdfs(
      zip,
      "Test#Pass9",
      path.join(dir, "extracted"),
    );
    assert.equal(pdfs.length, 1);
    assert.equal(path.basename(pdfs[0]), "note.pdf");
  });

  it("fails with a wrong password, without leaking it", async () => {
    const zip = path.join(dir, "out2.zip");
    await zipFolder(path.join(dir, "src"), zip, "Right#Pass9");
    await assert.rejects(
      extractPdfs(zip, "Wrong#Pass9", path.join(dir, "extracted2")),
      (e) => !e.message.includes("Wrong#Pass9"),
    );
  });

  it("passes a plain PDF straight through", async () => {
    const pdf = path.join(dir, "src", "note.pdf");
    assert.deepEqual(await extractPdfs(pdf, "unused", path.join(dir, "x")), [
      pdf,
    ]);
  });
});
