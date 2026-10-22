// Same function as billerbob/src/utils/dateWindow.js.
import { DateTime } from "luxon";

export const BILLING_ZONE = "America/New_York";

/**
 * Returns the previous calendar day in New York time as a half-open
 * window [start, end): start is inclusive, end is exclusive.
 *
 * @param {DateTime} now
 * @returns {{ start: DateTime, end: DateTime }}
 */
export const getPreviousDayWindow = (now) => {
  if (!DateTime.isDateTime(now) || !now.isValid) {
    throw new Error(
      "getPreviousDayWindow: `now` must be a valid Luxon DateTime",
    );
  }

  const todayStart = now.setZone(BILLING_ZONE).startOf("day");
  const yesterdayStart = todayStart.minus({ days: 1 });

  return { start: yesterdayStart, end: todayStart };
};
