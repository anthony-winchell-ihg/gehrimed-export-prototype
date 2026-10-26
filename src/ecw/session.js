// Opens eCW and makes sure it's logged in.
//
// The login, as mapped on live eCW (2026-10-23): username → Next → password →
// Log In → eClinicalWorks emails a link the person must click; the page then
// moves on to the home screen by itself. Nothing to type for that second step,
// so the program waits for a person, and says so.
//
// Safety rules:
//   - ONE failed sign-in and it stops: repeated wrong passwords lock the account.
//   - It never repeats the email step by itself: every try sends another email.
//   - A CAPTCHA / bot check means stop: that's for a person, never for the program.
import { chromium } from "playwright";

export const ECW_HOME =
  process.env.ECW_URL ||
  "https://flhfhcapp.ecwcloud.com/mobiledoc/jsp/webemr/index.jsp";

// The screens we know, and how to recognize each one.
const SCREENS = {
  home: "a.icon-usersearch", // only there once logged in
  username: "input#doctorID[type=text]",
  password: "#passwordField",
  email: "#resendOtpBtn",
  botCheck: 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile',
};

const EMAIL_WAIT_MS = 10 * 60_000;

// A sign-in problem a person must fix. Don't log in again automatically after one.
export class SignInError extends Error {
  name = "SignInError";
}

// Waits until the page shows one of the known screens, and returns its name
const whichScreen = async (page, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const [name, selector] of Object.entries(SCREENS)) {
      if (await page.locator(selector).first().isVisible()) return name;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    "eCW didn't reach a known screen (home, login, or email confirmation)",
  );
};

/** Clicks `button` and waits until the browser is on a NEW page (or `timeout` passes). */
const clickAndWaitForNewPage = async (page, button, timeout = 60_000) => {
  await page.evaluate(() => (window.__beforeClick = true)); // a new page won't have this
  await button.click();
  await page
    .waitForFunction(() => !window.__beforeClick, null, { timeout })
    .catch(() => {});
};

/**
 * Makes sure `page` is logged in to eCW, logging in if needed.
 * Throws SignInError when a person has to step in.
 * @param {import("playwright").Page} page
 * @param {{ username?: string, password?: string, homeUrl?: string, emailWaitMs?: number, log?: (msg: string) => void }} options
 */
export const ensureLoggedIn = async (
  page,
  {
    username,
    password,
    homeUrl = ECW_HOME,
    emailWaitMs = EMAIL_WAIT_MS,
    log = console.log,
  } = {},
) => {
  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  let screen = await whichScreen(page);

  if (screen === "home") return; // still logged in

  if (screen === "botCheck")
    throw new SignInError(
      "eCW is showing a CAPTCHA / bot check - a person needs to log in",
    );

  if (!username || !password)
    throw new SignInError(
      "eCW sign-in needs ECW_USERNAME and ECW_PASSWORD in .env",
    );

  if (screen === "username") {
    await page.locator(SCREENS.username).fill(username);
    await clickAndWaitForNewPage(page, page.locator("#nextStep"));
    screen = await whichScreen(page);
  }

  if (screen === "password") {
    await page.locator(SCREENS.password).fill(password);
    await clickAndWaitForNewPage(page, page.locator("#Login"));
    screen = await whichScreen(page);
    if (screen === "password" || screen === "username") {
      throw new SignInError(
        "eCW sign-in failed: still on the login page after Log In (wrong username or password?)",
      );
    }
  }

  if (screen === "botCheck")
    throw new SignInError(
      "eCW is showing a CAPTCHA / bot check - a person needs to log in",
    );

  if (screen === "email") {
    log(
      `📧 Confirm the eCW login: open the email from eClinicalWorks and follow the steps to approve the sign-in (waiting up to ${Math.round(emailWaitMs / 60_000)} min)`,
    );
    try {
      await page
        .locator(SCREENS.home)
        .waitFor({ state: "visible", timeout: emailWaitMs });
    } catch {
      throw new SignInError(
        "eCW login email wasn't confirmed in time - not trying again by itself (each try sends another email)",
      );
    }
    screen = "home";
  }

  if (screen !== "home")
    throw new SignInError(
      `eCW: unexpected screen after logging in (${screen})`,
    );
};

/**
 * Starts a new browser that keeps its profile in `profileDir` (cookies survive restarts).
 * @returns {Promise<{ context: import("playwright").BrowserContext, page: import("playwright").Page }>}
 */
export const openEcw = async ({ profileDir, headless = true }) => {
  if (!profileDir) throw new Error("openEcw: profileDir is missing");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
};
