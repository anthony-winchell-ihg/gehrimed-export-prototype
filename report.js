// Bundles what's needed to troubleshoot a failure into one file you can send:
//   • the last part of today's watch log (encounter IDs, counts, error details)
//   • the newest page-structure snapshot (controls and labels — no patient data)
//
//   npm run report                 # → debug/report-<time>.txt
//   npm run report -- --lines 300  # more of the log
//
// Look the file over before sending it.
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { DateTime } from "luxon";
import {
  debugDir,
  logDir,
  outputDir,
  retentionDays,
  watchIntervalMinutes,
} from "./src/config.js";

const { values: args } = parseArgs({
  options: { lines: { type: "string", default: "150" } },
});
const lines = Number(args.lines) || 150;

const newest = async (dir, pattern) => {
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) =>
    pattern.test(n),
  );
  const withTimes = await Promise.all(
    names.map(async (n) => ({
      n,
      t: (await fs.stat(path.join(dir, n))).mtimeMs,
    })),
  );
  withTimes.sort((a, b) => b.t - a.t);
  return withTimes[0] ? path.join(dir, withTimes[0].n) : null;
};

const pkg = JSON.parse(
  await fs.readFile(new URL("./package.json", import.meta.url), "utf8"),
);
const parts = [
  `GEHRIMed export — troubleshooting report`,
  `Created: ${DateTime.now().setZone("America/New_York").toFormat("yyyy-MM-dd HH:mm:ss")} (New York)`,
  `Version: ${pkg.version} · Node ${process.version} · ${process.platform}`,
  `Settings: check every ${watchIntervalMinutes} min · keep ${retentionDays} days · output folder ${outputDir === path.resolve("output") ? "(default)" : "(custom, set in .env)"}`,
  "",
];

const log = await newest(logDir, /^watch-.*\.log$/);
if (log) {
  const all = (await fs.readFile(log, "utf8")).split(/\r?\n/);
  parts.push(
    `===== Last ${Math.min(lines, all.length)} lines of ${path.basename(log)} =====`,
    ...all.slice(-lines),
    "",
  );
} else {
  parts.push("===== (no watch log found) =====", "");
}

const snap = await newest(debugDir, /^snapshot-.*\.txt$/);
if (snap) {
  parts.push(
    `===== Newest snapshot: ${path.basename(snap)} =====`,
    await fs.readFile(snap, "utf8"),
  );
} else {
  parts.push("===== (no snapshot found) =====");
}

await fs.mkdir(debugDir, { recursive: true });
const out = path.join(
  debugDir,
  `report-${DateTime.now().toFormat("yyyy-MM-dd_HHmmss")}.txt`,
);
await fs.writeFile(out, parts.join("\n"), "utf8");
console.log(`📋 Report saved: ${out}`);
console.log(
  "   Contains log lines (encounter IDs, counts, errors) and a page-structure snapshot — no patient names.",
);
console.log("   Look it over before sending it.");
