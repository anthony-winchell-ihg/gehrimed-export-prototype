// Copies everything printed to the console into a daily log file:
//   <LOG_DIR>/<name>-yyyy-MM-dd.log   (New York date; a new file each day)
// Every line in the file gets a timestamp. The console output is unchanged.
//
// What gets logged is exactly what the terminal shows — encounter IDs, counts
// and errors, never patient names.
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";

const ZONE = "America/New_York";

/**
 * Starts copying console output to daily log files. Call once, at startup.
 * @returns {{ file: () => string }} the current log file path
 */
export const startFileLogging = (logDir, name) => {
  fs.mkdirSync(logDir, { recursive: true });

  let currentDay = null;
  let stream = null;
  let currentFile = null;

  const streamForToday = () => {
    const day = DateTime.now().setZone(ZONE).toFormat("yyyy-MM-dd");
    if (day !== currentDay) {
      stream?.end();
      currentDay = day;
      currentFile = path.join(logDir, `${name}-${day}.log`);
      stream = fs.createWriteStream(currentFile, { flags: "a" });
    }
    return stream;
  };

  const write = (level, args) => {
    const text = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    const ts = DateTime.now().setZone(ZONE).toFormat("yyyy-MM-dd HH:mm:ss");
    const tag = level === "log" ? "" : ` ${level.toUpperCase()}`;
    const lines = text.split(/\r?\n/).map((l) => `${ts}${tag} ${l}`).join("\n");
    try {
      streamForToday().write(lines + "\n");
    } catch {
      // never let logging break the export
    }
  };

  for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      write(level, args);
    };
  }

  // Crashes: log them, then exit with an error code so Task Scheduler restarts us.
  const crash = (label) => (err) => {
    console.error(`💥 ${label}:`, err);
    stream?.end(() => process.exit(1));
    setTimeout(() => process.exit(1), 2_000).unref();
  };
  process.on("uncaughtException", crash("Crashed"));
  process.on("unhandledRejection", crash("Crashed (unhandled promise rejection)"));

  return { file: () => currentFile ?? streamForToday().path };
};
