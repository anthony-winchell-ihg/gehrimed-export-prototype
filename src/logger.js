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

let writeToFileOnly = () => {}; // set by startFileLogging

/**
 * Writes to the log FILE only (not the terminal) — for full error details,
 * e.g. Playwright's explanation of which element couldn't be clicked and why.
 * Those name page elements and labels, never patient data.
 */
export const logDetails = (label, error) => {
  // The message (for Playwright: which element, and why it couldn't be used),
  // then a few "at ..." lines showing where in our code it happened.
  const where =
    error instanceof Error && error.stack
      ? error.stack
          .split("\n")
          .filter((l) => /^\s+at /.test(l))
          .slice(0, 4)
      : [];
  const text = [
    error instanceof Error ? error.message : String(error),
    ...where,
  ].join("\n");
  writeToFileOnly(
    `   ↳ details for ${label}:\n${text
      .split("\n")
      .map((l) => `      ${l}`)
      .join("\n")}`,
  );
};

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
      .map((a) =>
        a instanceof Error
          ? a.stack || a.message
          : typeof a === "string"
            ? a
            : JSON.stringify(a),
      )
      .join(" ");
    const ts = DateTime.now().setZone(ZONE).toFormat("yyyy-MM-dd HH:mm:ss");
    const tag = level === "log" ? "" : ` ${level.toUpperCase()}`;
    const lines = text
      .replace(/\x1b\[[0-9;]*m/g, "") // strip terminal color codes (Playwright adds them)
      .split(/\r?\n/)
      .map((l) => `${ts}${tag} ${l}`)
      .join("\n");
    try {
      streamForToday().write(lines + "\n");
    } catch {
      // never let logging break the export
    }
  };

  writeToFileOnly = (text) => write("details", [text]);

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
  process.on(
    "unhandledRejection",
    crash("Crashed (unhandled promise rejection)"),
  );

  return { file: () => currentFile ?? streamForToday().path };
};
