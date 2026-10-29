// When watch mode is allowed to check GEHRIMed, e.g. 07:30–17:00 Monday–Friday
// (New York time). Outside those hours it stays running but idle: no checks,
// no logins, browser closed. Nothing is missed — the first check afterwards
// catches up on every day since the last complete check.
import { BILLING_ZONE } from "./dateWindow.js";

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]; // Luxon weekday 1–7

const parseTime = (s, what) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59)
    throw new Error(`ACTIVE_HOURS: bad ${what} time "${s}" (use HH:mm)`);
  return Number(m[1]) * 60 + Number(m[2]);
};

const parseDay = (s) => {
  const i = DAY_NAMES.indexOf(s.trim().toLowerCase().slice(0, 3));
  if (i < 0)
    throw new Error(`ACTIVE_DAYS: unknown day "${s}" (use mon, tue, … sun)`);
  return i + 1;
};

/**
 * @param {string} hours "07:30-17:00", or "always"
 * @param {string} days  "mon-fri", "mon,wed,fri", or "all"
 * @returns {{ start: number, end: number, days: Set<number> } | null} minutes after midnight; null = always active
 */
export const parseActiveHours = (hours = "07:30-17:00", days = "mon-fri") => {
  const allDays = days.trim().toLowerCase() === "all";
  if (hours.trim().toLowerCase() === "always" && allDays) return null;

  let start = 0;
  let end = 24 * 60;
  if (hours.trim().toLowerCase() !== "always") {
    const [from, to, extra] = hours.split("-");
    if (to === undefined || extra !== undefined)
      throw new Error(`ACTIVE_HOURS: "${hours}" should look like 07:30-17:00`);
    start = parseTime(from, "start");
    end = parseTime(to, "end");
    if (end <= start)
      throw new Error(`ACTIVE_HOURS: end must be after start in "${hours}"`);
  }

  const set = new Set();
  if (allDays) {
    for (let d = 1; d <= 7; d++) set.add(d);
  } else {
    for (const part of days.split(",")) {
      const [a, b] = part.split("-");
      if (b === undefined) set.add(parseDay(a));
      else
        for (let d = parseDay(a), last = parseDay(b); ; d = (d % 7) + 1) {
          set.add(d);
          if (d === last) break;
        }
    }
  }
  return { start, end, days: set };
};

/** Whether `now` falls inside the active hours (start inclusive, end exclusive). */
export const isActive = (now, schedule) => {
  if (!schedule) return true;
  const t = now.setZone(BILLING_ZONE);
  const minutes = t.hour * 60 + t.minute;
  return (
    schedule.days.has(t.weekday) &&
    minutes >= schedule.start &&
    minutes < schedule.end
  );
};

/** The next moment the active hours begin (or `now` if they already have). */
export const nextActiveStart = (now, schedule) => {
  if (isActive(now, schedule)) return now;
  const t = now.setZone(BILLING_ZONE);
  for (let i = 0; i <= 7; i++) {
    const day = t.startOf("day").plus({ days: i });
    // set(), not plus(minutes): on a daylight-saving day, plus() would be an hour off.
    const start = day.set({
      hour: Math.floor(schedule.start / 60),
      minute: schedule.start % 60,
    });
    if (schedule.days.has(day.weekday) && start > t) return start;
  }
  throw new Error("ACTIVE_DAYS has no days in it");
};

/**
 * The first check time strictly after `now` on a fixed clock grid: every
 * `intervalMs`, counted from midnight New York time, shifted by `offsetMs`.
 * E.g. every 30 min, offset 10 min → :10 and :40 past each hour, whenever the
 * program was started. Built from the wall clock (set(), not plus()), so a
 * daylight-saving day doesn't shift it by an hour.
 */
export const nextSlot = (now, intervalMs, offsetMs = 0) => {
  const t = now.setZone(BILLING_ZONE);
  const sinceMidnight = ((t.hour * 60 + t.minute) * 60 + t.second) * 1000 + t.millisecond;
  const offset = ((offsetMs % intervalMs) + intervalMs) % intervalMs;
  let slot = (Math.floor((sinceMidnight - offset) / intervalMs) + 1) * intervalMs + offset;
  let day = t.startOf("day");
  if (slot >= 24 * 60 * 60_000) {
    day = day.plus({ days: 1 });
    slot = offset;
  }
  return day.set({
    hour: Math.floor(slot / 3_600_000),
    minute: Math.floor(slot / 60_000) % 60,
    second: Math.floor(slot / 1000) % 60,
    millisecond: Math.round(slot % 1000),
  });
};

/** "07:30-17:00 mon,tue,wed,thu,fri" for the startup message. */
export const describeActiveHours = (schedule) => {
  if (!schedule) return "always";
  const hm = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${hm(schedule.start)}–${hm(schedule.end)} ${[...schedule.days]
    .sort()
    .map((d) => DAY_NAMES[d - 1])
    .join(",")}`;
};
