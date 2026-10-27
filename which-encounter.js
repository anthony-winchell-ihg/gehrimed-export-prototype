// Which encounter is this PDF? Hashes the file and looks it up in the export's
// manifest (state/manifest.jsonl) — this still works after billing renames or
// moves the file. Prints IDs and dates only.
//
//   node --env-file-if-exists=.env which-encounter.js "<path to the PDF>"
import { manifestFile } from "./src/config.js";
import { readManifest, sha256File } from "./src/manifest.js";

const file = process.argv[2];
if (!file) {
  console.error('Usage: node which-encounter.js "<path to the PDF>"');
  process.exit(2);
}

const hash = await sha256File(file);
const matches = (await readManifest(manifestFile)).filter(
  (e) => e.sha256 === hash,
);
if (!matches.length) {
  console.error(
    "❌ Not in the export's manifest: this PDF wasn't saved by the export (or its content changed).",
  );
  process.exit(1);
}
for (const e of matches) {
  console.log(
    `Encounter ${e.encounterId} · signed ${e.signedOn} · date of service ${e.dateOfService}`,
  );
  console.log(
    `   npm run ecw-upload -- --date ${e.signedOn} --mode check --encounter ${e.encounterId}`,
  );
}
