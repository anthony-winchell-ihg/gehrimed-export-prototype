// Which file is which encounter — for the next step (filing the PDFs in eCW).
// One JSON line per saved PDF, appended to state/manifest.jsonl and kept:
//
//   {"encounterId":"900000100","patientId":"100000","dateOfService":"2026-10-12",
//    "signedOn":"2026-10-13","sha256":"…","exportedAt":"…"}
//
// No file name and no patient name (the file name contains the name). The next
// step finds a PDF by hashing it and looking up the sha256 — which still works
// after billing renames or moves the file.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

export const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

/** Appends one line per entry (one write, so a crash can't leave half a line). */
export const appendManifest = async (file, entries) => {
  if (!entries.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(
    file,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
};

/** All manifest lines (skips a damaged line rather than failing). */
export const readManifest = async (file) => {
  const text = await fs
    .readFile(file, "utf8")
    .catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
};
