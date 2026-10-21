// Decides whether an eCW patient search found the right chart for an encounter.
//
// This is the riskiest decision in the upload: a note filed in the wrong chart
// is a privacy incident that only eCW support can fix. So it FAILS CLOSED —
// it only answers "match" when every check positively passes; anything
// missing, unreadable or ambiguous is not a match.
//
// Reasons are safe to log: they name which check failed, never the values.
import { DateTime } from "luxon";

// eCW formats DOB "mm/dd/yyyy"
const ECW_DOB_FORMAT = "MM/dd/yyyy";

/**
 * Letters only, upper case: "Garcia-Lopez", "GARCIA LOPEZ" and "García López"
 * all become "GARCIALOPEZ". The two systems differ in capitals, spaces,
 * hyphens and accents; this makes those equal without fuzzy matching.
 */
const normalizeName = (s) =>
  String(s ?? "")
    .normalize("NFKD") // splits "í" into "i" + an accent mark…
    .replace(/[^A-Za-z]/g, "") // …so removing non-letters keeps the "i"
    .toUpperCase();

/**
 *
 * @param {{ lastName: string, dob: string }[]} results  rows read from eCW's search results
 * @param {{ lastName: string, dateOfBirth: DateTime }} expected  the patient from GEHRIMed
 * @returns {{ result: "match" | "not-found" | "several" | "mismatch", reason?: string }}
 */
export const decideMatch = (results, expected) => {
  // Missing expected data is a bug in my code, not a data problem: stop loudly
  const expectedName = normalizeName(expected?.lastName);

  if (!expectedName)
    throw new Error("decideMatch: expected.lastName is missing");

  if (
    !DateTime.isDateTime(expected.dateOfBirth) ||
    !expected.dateOfBirth.isValid
  ) {
    throw new Error(
      "decideMatch: expected.dateOfBirth must be a valid Luxon DateTime",
    );
  }

  if (results.length === 0)
    return { result: "not-found", reason: "no patient has this External MRN" };

  if (results.length > 1)
    return {
      result: "several",
      reason: `${results.length} patients have this External MRN`,
    };

  const [found] = results;
  const foundDob = DateTime.fromFormat(
    String(found.dob ?? "").trim(),
    ECW_DOB_FORMAT,
  );
  if (!foundDob.isValid)
    return { result: "mismatch", reason: "unreadable DOB in eCW" };
  if (foundDob.toISODate() !== expected.dateOfBirth.toISODate())
    return { result: "mismatch", reason: "DOB differs" };
  if (normalizeName(found.lastName) !== expectedName)
    return { result: "mismatch", reason: "last name differs" };

  return { result: "match" };
};
