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
  const letters = String(s ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z]/g, "");
  return letters
    ? letters[0].toUpperCase() + letters.slice(1).toLowerCase()
    : "";
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
 * encounter shows as failed and is retried) rather than misnamed.
 */
export const buildPdfName = ({
  firstName,
  lastName,
  dateOfBirth,
  dateOfService,
}) => {
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
  if (missing.length)
    throw new Error(
      `Can't build file name — missing/unreadable: ${missing.join(", ")}`,
    );
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

/**
 * Reads a file name made by buildPdfName back into its parts (the reverse of
 * buildPdfName). Each name part is one capital followed by lower-case letters
 * (that's how cleanName writes it), so "ObrienMaryjo" splits cleanly into
 * last "Obrien" and first "Maryjo". A "_2", "_3"... suffix is allowed.
 * Returns null for any name not in exactly that format (e.g. one billing renamed).
 */
export const parsePdfName = (fileName) => {
  const m =
    /^([A-Z][a-z]*)([A-Z][a-z]*)_DOB(\d{2}\.\d{2}\.\d{4})_DOS(\d{2}\.\d{2}\.\d{4})(?:_\d+)?\.pdf$/.exec(
      String(fileName ?? ""),
    );

  if (!m) return null;

  const [, lastName, firstName, dob, dos] = m;

  const dateOfBirth = DateTime.fromFormat(dob, DATE_FORMAT);
  const dateOfService = DateTime.fromFormat(dos, DATE_FORMAT);

  if (!dateOfBirth.isValid || !dateOfService.isValid) return null;

  return { lastName, firstName, dateOfBirth, dateOfService };
};
