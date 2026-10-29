// Takes an encounter off the eCW manual list once a person has looked at it.
//
//   npm run ecw-resolve                              # show the manual list
//   npm run ecw-resolve -- 995274872 --uploaded      # it IS in the chart (the upload worked, or you uploaded it by hand)
//   npm run ecw-resolve -- 995274872 --retry         # it is NOT in the chart: try it again automatically
//
// Safe while ecw-watch is running: it picks the change up at its next check —
// and if it had stopped uploading because of this encounter, it starts again.
// Only encounters on the manual list can be resolved. Changes state/uploads.json
// only (IDs and statuses — no names); nothing in eCW.
import { parseArgs } from "node:util";
import { uploadsFile } from "./src/config.js";
import { loadUploads } from "./src/uploads.js";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    uploaded: { type: "boolean", default: false },
    retry: { type: "boolean", default: false },
  },
});

const refuse = (message) => {
  console.error(`❌ ${message}`);
  process.exit(2);
};

const uploads = await loadUploads(uploadsFile);
const manual = uploads.needsManual();

if (!positionals.length) {
  if (args.uploaded || args.retry) refuse("Name the encounter: npm run ecw-resolve -- <encounter ID> --uploaded | --retry");
  if (!manual.length) {
    console.log("✅ The manual list is empty.");
  } else {
    console.log(`🙋 Manual list: ${manual.length} encounter(s) need a person:`);
    for (const m of manual) console.log(`   ${m.encounterId}: ${m.reason}`);
    console.log("\nOnce you've checked one in eCW:");
    console.log("   npm run ecw-resolve -- <encounter ID> --uploaded   # it's in the chart");
    console.log("   npm run ecw-resolve -- <encounter ID> --retry      # it isn't: try again automatically");
  }
  process.exit(0);
}

if (positionals.length > 1) refuse("One encounter at a time, please.");
if (args.uploaded === args.retry) refuse("Say what you found: --uploaded (it's in the chart) or --retry (it isn't).");

const [encounterId] = positionals;
const entry = manual.find((m) => m.encounterId === encounterId);
if (!entry) {
  const status = uploads.status(encounterId);
  refuse(
    `${encounterId} isn't on the manual list` +
      (status ? ` (its status is "${status}")` : " (nothing is recorded for it)") +
      ". Run npm run ecw-resolve to see the list.",
  );
}

const outcome = args.uploaded ? "uploaded" : "retry";
const before = await uploads.resolve(encounterId, outcome);
if (outcome === "uploaded") {
  console.log(`✅ ${encounterId}: marked uploaded (by a person). It won't be uploaded again.`);
} else {
  console.log(`🔁 ${encounterId}: will be tried again at the next check.`);
  if (before === "started")
    console.log("   (Its last upload was interrupted — only retry if you've checked the chart and it's NOT there.)");
}
console.log("   ecw-watch picks this up at its next check (no restart needed).");
