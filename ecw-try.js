// Read-only check of the eCW search against LIVE eCW, on the TEST patient.
//
//   node ecw-try.js <External MRN of the test patient>
//
// Opens a visible browser; you log in by hand (username, password, emailed
// code). Then it searches by that External MRN, then by an MRN that can't
// exist (the result must be 0 rows — not the previous search's rows).
// Prints counts only — no names, no DOBs. It never clicks a result row.
import path from "node:path";
import { chromium } from "playwright";
import { findByExternalMrn } from "./src/ecw/search.js";
import { projectDir } from "./src/config.js";

const ECW_URL = "https://flhfhcapp.ecwcloud.com/mobiledoc/jsp/webemr/index.jsp";
// eCW's cookies are kept here between runs (e.g. "remember this device").
// It's under state/, which git ignores: it holds a logged-in session.
const PROFILE_DIR = path.join(projectDir, "state", "ecw-profile");

const mrn = process.argv[2];

if (!mrn) {
  console.error("Usage: node ecw-try.js <External MRN of the TEST patient>");
  process.exit(2);
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
});
const page = context.pages()[0] ?? (await context.newPage());

try {
  await page.goto(ECW_URL, { waitUntil: "domcontentloaded" });
  console.log("Log in to eCW in the browser widow (including 2FA)...");

  await page
    .locator("a.icon-usersearch")
    .waitFor({ state: "visible", timeout: 5 * 60_000 });
  console.log("Logged in.");

  const found = await findByExternalMrn(page, mrn);
  const readable = found.map((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r.dob));
  console.log(
    `Search 1: ${found.length} result(s); DOB readable per row: ${readable.join(", ") || "-"}`,
  );

  const none = await findByExternalMrn(page, "ZZ-NO-SUCH-MRN");
  console.log(
    `Search 2 (an MRN that can't exist): ${none.length} result(s), should be 0`,
  );
} finally {
  await context.close();
}
