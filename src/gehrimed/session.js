// Steps 1–2: open GEHRIMed and log in.
//
// Real login flow (inspected 2026-10-19):
//   1. app.gehrimed.com shows "Username or Email" (<input id="userName">) + "Next"
//   2. the page redirects to Netsmart's Okta sign-in at auth.netsmartcloud.com:
//      #okta-signin-username (pre-filled), #okta-signin-password, #okta-signin-submit
//   3. Okta redirects back to GEHRIMed's dashboard
//
// With GEHRIMED_USERNAME and GEHRIMED_PASSWORD set (in .env), the script logs in
// by itself. Without them, the person running it logs in by hand. Credentials
// are never logged.
import { chromium } from "playwright";
import { findVisible, step } from "./ui.js";

// GEHRIMED_URL can be overridden only so the tests can point at a local mock.
const GEHRIMED_URL = process.env.GEHRIMED_URL || "https://app.gehrimed.com";

const dashboardMenu = (f) => f.getByText("Search", { exact: true });

const credentials = () => {
  const username = process.env.GEHRIMED_USERNAME;
  const password = process.env.GEHRIMED_PASSWORD;
  return username && password ? { username, password } : null;
};

/**
 * Opens a browser at GEHRIMed and logs in.
 * @returns {{ browser, context, page }}
 */
export const openGehrimed = async ({ headless = false, loginTimeoutMs = 5 * 60_000 } = {}) => {
  if (headless && !credentials()) {
    throw new Error("Running headless needs GEHRIMED_USERNAME and GEHRIMED_PASSWORD in .env (no one can log in by hand)");
  }
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  // If anything below fails, close the browser — otherwise it's left running.
  try {
    await goToDashboard(page, { loginTimeoutMs });
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
  return { browser, context, page };
};

/**
 * (Re)loads GEHRIMed and makes sure we end up on the dashboard — logging in
 * again if the session has expired. Watch mode calls this before every check,
 * which also clears any dialogs left open by the previous check.
 */
export const goToDashboard = async (page, { loginTimeoutMs = 5 * 60_000 } = {}) => {
  await loadGehrimed(page);

  const creds = credentials();
  const outcome = await Promise.race([
    findVisible(page, dashboardMenu, "the GEHRIMed dashboard", { timeout: 60_000 }).then(() => "dashboard"),
    page.locator("#userName, #okta-signin-password").first().waitFor({ timeout: 60_000 }).then(() => "login"),
  ]).catch(() => "unknown");

  if (outcome === "dashboard") return;

  if (creds) {
    await autoLogin(page, creds.username, creds.password);
  } else {
    console.log("👉 Log in to GEHRIMed in the browser window. Waiting up to 5 minutes...");
  }
  await findVisible(page, dashboardMenu, "the GEHRIMed dashboard", {
    timeout: creds ? 90_000 : loginTimeoutMs,
  });
  console.log("✅ Logged in.");
};

/**
 * Opens GEHRIMed. Only waits for the page's HTML ("domcontentloaded"), NOT the
 * full "load" event: GEHRIMed's dashboard keeps loading frames and background
 * requests for a long time, so waiting for "load" can time out even though
 * the page works. The callers then wait for the actual dashboard or login
 * screen to appear. One retry if even that is slow.
 */
const loadGehrimed = async (page) => {
  // Brief network drops (after sleep, Wi-Fi/VPN reconnecting) show up as
  // net::ERR_NAME_NOT_RESOLVED, ERR_INTERNET_DISCONNECTED, ERR_NETWORK_CHANGED…
  // (seen 2026-10-20). Wait and retry those instead of failing the whole check.
  const NETWORK = /net::ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|CONNECTION_\w+|ADDRESS_UNREACHABLE|TIMED_OUT|NETWORK_IO_SUSPENDED)/;
  const networkWaits = [5_000, 15_000, 30_000];
  let networkTries = 0;
  let slowTries = 0;
  for (;;) {
    try {
      await page.goto(GEHRIMED_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (e) {
      const network = e.message.match(NETWORK);
      if (network && networkTries < networkWaits.length) {
        const wait = networkWaits[networkTries++];
        step(`network problem (${network[0].replace("net::", "")}) — trying again in ${wait / 1000}s`);
        await page.waitForTimeout(wait);
        continue;
      }
      if (/Timeout/i.test(e.message) && slowTries++ < 1) {
        step("GEHRIMed is slow to load — trying again");
        continue;
      }
      if (network) throw new Error(`Can't reach GEHRIMed — network problem (${network[0].replace("net::", "")}) for over a minute`);
      throw e;
    }
  }
};

const autoLogin = async (page, username, password) => {
  console.log("🔐 Logging in automatically...");

  // 1. GEHRIMed's username screen (skip if we're already on Netsmart's page)
  const userBox = page.locator("#userName");
  if (await userBox.isVisible().catch(() => false)) {
    step("entering username");
    await userBox.fill(username);
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }

  // 2. Netsmart's Okta sign-in page
  step("waiting for the Netsmart sign-in page");
  const passwordBox = page.locator("#okta-signin-password");
  await passwordBox.waitFor({ timeout: 60_000 });

  const oktaUser = page.locator("#okta-signin-username");
  if ((await oktaUser.inputValue().catch(() => "")) !== username) await oktaUser.fill(username);

  step("entering password");
  await passwordBox.fill(password);
  await page.locator("#okta-signin-submit").click();

  // 3. Either we land on the dashboard, or Okta shows an error / extra verification.
  step("waiting for GEHRIMed to open");
  const errorBox = page
    .locator(".o-form-error-container, .okta-form-infobox-error, .o-form-input-error")
    .filter({ hasText: /\S/ })
    .first();
  const outcome = await Promise.race([
    findVisible(page, dashboardMenu, "the GEHRIMed dashboard", { timeout: 90_000 }).then(() => "ok"),
    errorBox.waitFor({ timeout: 90_000 }).then(() => "error"),
    page.locator("[data-se*='factor'], .mfa-verify, .authenticator-verify-list, [data-se='o-form-head']")
      .filter({ hasText: /verify|verification|factor|code/i }).first().waitFor({ timeout: 90_000 }).then(() => "mfa"),
  ]).catch(() => "timeout");

  if (outcome === "error") {
    const msg = (await errorBox.innerText().catch(() => "")).trim().slice(0, 120);
    throw new Error(`Netsmart sign-in failed: ${msg || "check GEHRIMED_USERNAME / GEHRIMED_PASSWORD"}`);
  }
  if (outcome === "mfa") {
    throw new Error("Netsmart is asking for extra verification (MFA). Run once without --headless and log in by hand, or ask IT about this account's sign-in policy.");
  }
  if (outcome === "timeout") {
    throw new Error("Logged in, but the GEHRIMed dashboard never appeared");
  }
};
