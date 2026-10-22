// Makes sure only ONE export runs at a time (watch mode, or a catch-up run).
// Two at once would each keep their own copy of the "already exported" record
// and overwrite each other's saves — causing duplicate downloads and _2 files.
//
// The lock is a file holding the process ID. A lock left behind by a process
// that no longer exists (crash, power loss) is taken over automatically.
import fs from "node:fs";
import path from "node:path";

const isRunning = (pid) => {
  try {
    process.kill(pid, 0); // signal 0 = "does this process exist?"
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, just not ours to signal
  }
};

/**
 * Takes the lock or throws. Releases it automatically on exit.
 * @param lockFile  e.g. state/export.lock
 * @param label     what's running ("watch", "export") — shown to whoever is blocked
 */
export const acquireLock = (lockFile, label) => {
  try {
    const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (held.pid !== process.pid && isRunning(held.pid)) {
      throw new Error(
        `Another export is already running (${held.label}, process ${held.pid}, since ${held.since}). ` +
          "Stop it first — two at once cause duplicate downloads.",
      );
    }
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: process.pid,
      label,
      since: new Date().toISOString(),
    }),
  );

  const release = () => {
    try {
      const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (held.pid === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {
      // already gone
    }
  };
  process.on("exit", release);
  return release;
};
