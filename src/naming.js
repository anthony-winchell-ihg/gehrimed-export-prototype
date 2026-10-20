// File names billing asked for: LastNameFirstName, then the date of birth and
// date of service, each labelled so they can't be mixed up:
//   e.g. first "MARY-JO", last "O'BRIEN", DOB 4/9/1931, DOS 10/12/2026
//        → ObrienMaryjo_DOB04.09.1931_DOS10.12.2026.pdf
//
// Names: letters only (spaces, hyphens, apostrophes removed — also keeps the
// name safe for Windows), each part capitalized. Dates: MM.dd.yyyy.
// To change the layout, edit DATE_FORMAT or the return line of buildPdfName().
import { DateTime } from "luxon";

const DATE_FORMAT = "MM.dd.yyyy";

const cleanName = (s) => {
  const letters = String(s ?? "").normalize("NFKD").replace(/[^A-Za-z]/g, "");
  return letters ? letters[0].toUpperCase() + letters.slice(1).toLowerCase() : "";
};

/** Parses GEHRIMed's date text (e.g. "4/19/1931"). Returns a DateTime or null. */
export const parseGehrimedDate = (text) => {
  const t = String(text ?? "").trim();
  for (const fmt of ["M/d/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "M/d/yy"]) {
    const d = DateTime.fromFormat(t, fmt);
    if (d.isValid) return d;
  }
  return null;
};

/**
 * Builds the PDF file name from a result row's patient details.
 * Throws if a required piece is missing, so a bad row is reported (and the
 * encounter shows as failed in the manifest) rather than misnamed.
 */
export const buildPdfName = ({ firstName, lastName, dateOfBirth, dateOfService }) => {
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  const dob = parseGehrimedDate(dateOfBirth);
  const dos = parseGehrimedDate(dateOfService);
  const missing = [
    !first && "first name",
    !last && "last name",
    !dob && "date of birth",
    !dos && "date of service",
  ].filter(Boolean);
  if (missing.length) throw new Error(`Can't build file name — missing/unreadable: ${missing.join(", ")}`);
  return `${last}${first}_DOB${dob.toFormat(DATE_FORMAT)}_DOS${dos.toFormat(DATE_FORMAT)}`;
};

/**
 * The same patient can have two encounters on one date of service. Returns
 * `base`, or `base_2`, `base_3`, ... — whichever isn't in `used` yet — and records it.
 */
export const uniqueName = (base, used) => {
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
  used.add(name.toLowerCase());
  return name;
};
