// The document name billing uses in eCW's Chart Documents:
//   date of service 10/12/2026 → "2026-10-12 Progress Note"
//
// eCW names an uploaded document after the FILE: its "CustomName" is the file
// name without ".pdf". So the upload copies the PDF to a temporary file with
// this name and uploads that — there's no separate rename step in eCW.
// To change the wording, edit DOC_LABEL; to change the date layout, DATE_FORMAT.
import { DateTime } from "luxon";
import { parseGehrimedDate } from "../naming.js";

const DATE_FORMAT = "yyyy-MM-dd";
const DOC_LABEL = "Progress Note";

/**
 * @param {DateTime | string} dateOfService  a Luxon date, or text like "10/12/2026" or "2026-10-12"
 * @returns {string} the document name eCW will show, e.g. "2026-10-12 Progress Note"
 */
export const buildEcwDocName = (dateOfService) => {
  const dos = DateTime.isDateTime(dateOfService)
    ? dateOfService
    : parseGehrimedDate(dateOfService);
  if (!dos?.isValid)
    throw new Error(
      "buildEcwDocName: date of service is missing or unreadable",
    );
  return `${dos.toFormat(DATE_FORMAT)} ${DOC_LABEL}`;
};

/** The temporary file to upload, e.g. "2026-10-12 Progress Note.pdf". */
export const ecwFileName = (dateOfService) =>
  `${buildEcwDocName(dateOfService)}.pdf`;
