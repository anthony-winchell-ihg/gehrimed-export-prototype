// Steps 11–12: unpack GEHRIMed's encrypted download, and build the final zip.
// Uses the 7-Zip program bundled by the `7zip-bin` package — nothing to install.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import sevenBin from "7zip-bin";
import { decryptPdf, isEncryptedPdf } from "./pdf.js";

const run = promisify(execFile);
const SEVEN_ZIP = sevenBin.path7za;

/** True if the file starts with the PDF signature "%PDF-". */
export const isPdf = async (file) => {
  const handle = await fs.open(file, "r");
  try {
    const { buffer } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    return buffer.toString("latin1") === "%PDF-";
  } finally {
    await handle.close();
  }
};

/**
 * Turns one GEHRIMed download into unencrypted PDFs. Handles:
 *   • a password-protected PDF  → removes the password
 *   • a 7-Zip/zip archive       → extracts it (and removes any PDF passwords inside)
 *   • a plain PDF               → returned as-is
 */
export const extractPdfs = async (download, password, outDir) => {
  await fs.mkdir(outDir, { recursive: true });
  if (await isPdf(download))
    return [await unlockPdf(download, password, outDir)];

  const archived = await extractArchivePdfs(
    download,
    password,
    path.join(outDir, "archive"),
  );
  return Promise.all(archived.map((pdf) => unlockPdf(pdf, password, outDir)));
};

// Returns an unencrypted version of `pdf` (the same file if it wasn't encrypted).
const unlockPdf = async (pdf, password, outDir) => {
  if (!(await isEncryptedPdf(pdf))) return pdf;
  const out = path.join(outDir, `unlocked_${path.basename(pdf)}`);
  await decryptPdf(pdf, out, password);
  return out;
};

const extractArchivePdfs = async (archive, password, outDir) => {
  await fs.mkdir(outDir, { recursive: true });
  try {
    await run(SEVEN_ZIP, ["x", archive, `-o${outDir}`, `-p${password}`, "-y"]);
  } catch (e) {
    // Don't echo the command line — it contains the password.
    throw new Error(
      `7-Zip could not extract the download (exit ${e.code ?? "?"})`,
    );
  }

  const files = await listFiles(outDir);
  const pdfs = [];
  for (const f of files) {
    if (await isPdf(f)) pdfs.push(f);
  }
  if (!pdfs.length) throw new Error("Download contained no PDF");
  return pdfs;
};

/**
 * Zips every file in `sourceDir` into `zipPath`. With a password, the zip is
 * AES-256 encrypted (open it with 7-Zip; Windows' built-in zip can't).
 */
export const zipFolder = async (sourceDir, zipPath, password) => {
  const args = ["a", "-tzip", zipPath, path.join(sourceDir, "*"), "-y"];
  if (password) args.push(`-p${password}`, "-mem=AES256");
  try {
    await run(SEVEN_ZIP, args);
  } catch (e) {
    throw new Error(`7-Zip could not create the zip (exit ${e.code ?? "?"})`);
  }
};

const listFiles = async (dir) => {
  const entries = await fs.readdir(dir, {
    withFileTypes: true,
    recursive: true,
  });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
};
