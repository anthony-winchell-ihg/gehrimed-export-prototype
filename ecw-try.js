// Read-only check of the eCW search against LIVE eCW, on the TEST patient.
//
//   node --env-file=.env ecw-try.js <External MRN of the test patient>
//
// Opens a visible browser and logs in with ECW_USERNAME / ECW_PASSWORD from
// .env, then waits for you to confirm the email from eClinicalWorks. Then it
// searches by that External MRN, then by an MRN that can't
import path from "node:path";
import { ensureLoggedIn, openEcw } from "./src/ecw/session.js";
import { findByExternalMrn } from "./src/ecw/search.js";
import { projectDir } from "./src/config.js";

// eCW's cookies are kept here between runs (e.g. "remember this device").
// It's under state/, which git ignores: it holds a logged-in session.
const PROFILE_DIR = path.join(projectDir, "state", "ecw-profile");

const mrn = process.argv[2];

if (!mrn) {
  console.error("Usage: node ecw-try.js <External MRN of the TEST patient>");
  process.exit(2);
}

const { context, page } = await openEcw({
  profileDir: PROFILE_DIR,
  headless: false,
});

try {
  await ensureLoggedIn(page, {
    username: process.env.ECW_USERNAME,
    password: process.env.ECW_PASSWORD,
  });
  console.log("Logged in");
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
