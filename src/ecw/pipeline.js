// One encounter through the whole eCW sequence — shared by ecw-upload.js (one
// date, run by hand) and live mode (ecw-watch.js), so both behave the same:
//
//   search by External MRN → decideMatch → open the Patient Hub (prompts are
//   never answered) → identity check on the Hub → Chart Documents →
//   check mode: stop here  |  confirm/upload: record "started" → upload →
//   count check → record "uploaded"
//
// What it returns or throws tells the caller what to do next:
//   { result: "uploaded" | "ready" | "manual" | "error", reason? }
//   throws SignInError            a person must log in: stop everything
//   throws UncertainUploadError   an upload may or may not have happened: stop
//                                 uploading until a person has checked the chart
import { findByExternalMrn } from "./search.js";
import { decideMatch } from "./match.js";
import { NeedsPersonError, checkHubIdentity, openChartDocuments, openPatientHub } from "./docs.js";
import { uploadToChartDocuments } from "./upload.js";
import { SignInError, ensureLoggedIn } from "./session.js";

/** An upload may or may not have reached eCW. Its record stays "started", so it's never retried by itself. */
export class UncertainUploadError extends Error {
  name = "UncertainUploadError";
  constructor(encounterId, message) {
    super(message);
    this.encounterId = encounterId;
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {object} item  one entry from encountersToCheck()
 * @param {{ mode: "check" | "confirm" | "upload", uploads: object, credentials: { username?: string, password?: string }, log?: (msg: string) => void }} o
 * @returns {Promise<{ result: "uploaded" | "ready" | "manual" | "error", reason?: string }>}
 */
export const processEncounter = async (page, item, { mode, uploads, credentials, log = console.log }) => {
  const writes = mode !== "check";
  /** Manual list (recorded only when this mode records anything). */
  const needsPerson = async (reason) => {
    if (writes) await uploads.markNeedsManual(item.encounterId, reason);
    return { result: "manual", reason };
  };

  if (item.problem) return needsPerson(item.problem);

  let started = false; // set the moment uploads.json says "started"
  try {
    await ensureLoggedIn(page, { ...credentials, log }); // a fresh home screen for every encounter

    const match = decideMatch(await findByExternalMrn(page, item.externalMrn), item.expected);
    if (match.result !== "match") return needsPerson(`${match.result}: ${match.reason}`);

    const note = match.note ? `; ${match.note}` : ""; // e.g. matched ignoring a Jr/Sr suffix

    const hub = await openPatientHub(page);
    await checkHubIdentity(hub, { externalMrn: item.externalMrn, dateOfBirth: item.expected.dateOfBirth });
    const count = await openChartDocuments(page, hub);
    if (!writes) return { result: "ready", reason: `would upload here; Chart Documents has ${count}${note}` };

    const outcome = await uploadToChartDocuments(page, {
      pdfPath: item.pdfPath,
      dateOfService: item.dateOfService,
      byPerson: mode === "confirm",
      log,
      beforeWrite: async () => {
        await uploads.markStarted(item.encounterId, item.dateOfService);
        started = true;
      },
    });
    if (!outcome.uploaded) return needsPerson(outcome.reason);
    await uploads.markUploaded(item.encounterId, item.dateOfService);
    return note ? { result: "uploaded", reason: note.slice(2) } : { result: "uploaded" };
  } catch (e) {
    if (e instanceof SignInError) throw e;
    if (e instanceof NeedsPersonError) return needsPerson(e.message);
    const reason = e.message.split("\n")[0];
    if (started) {
      await uploads.markUncertain(item.encounterId, reason).catch(() => {}); // stays "started"; the reason is for the manual list
      throw new UncertainUploadError(item.encounterId, reason);
    }
    if (writes) await uploads.markFailed(item.encounterId); // nothing was written: it may be retried
    return { result: "error", reason };
  }
};
