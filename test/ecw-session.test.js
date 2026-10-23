import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { MOCK_ECW_LOGIN, startMockEcw } from "./mock-ecw.js";
import { SignInError, ensureLoggedIn } from "../src/ecw/session.js";

describe("ensureLoggedIn", { timeout: 120_000 }, () => {
  let browser, context, page, mock, logged;
  before(async () => (browser = await chromium.launch()));
  after(async () => browser?.close());
  beforeEach(async () => {
    context = await browser.newContext(); // fresh cookies = logged out
    page = await context.newPage();
    logged = [];
  });
  afterEach(async () => {
    await context?.close();
    await mock?.close();
  });

  const login = (overrides = {}) =>
    ensureLoggedIn(page, {
      ...MOCK_ECW_LOGIN,
      homeUrl: mock.url,
      log: (m) => logged.push(m),
      ...overrides,
    });

  it("does nothing when already logged in", async () => {
    mock = await startMockEcw(); // no login required
    await login();
    assert.equal(mock.state.logins, 0);
  });

  it("logs in, asks the person to confirm the email, and reaches the home screen", async () => {
    mock = await startMockEcw({
      requireLogin: true,
      confirmEmailAfterMs: 1_000,
    });
    await login();
    assert.equal(await page.locator("a.icon-usersearch").isVisible(), true);
    assert.equal(mock.state.logins, 1);
    assert.equal(mock.state.emailsSent, 1);
    assert.match(logged.join("\n"), /Confirm the eCW login/);
  });

  it("stops after ONE wrong password, without trying again", async () => {
    mock = await startMockEcw({ requireLogin: true });
    await assert.rejects(() => login({ password: "wrong" }), SignInError);
    assert.equal(mock.state.failedLogins, 1);
  });

  it("gives up if the email isn't confirmed in time, having sent only one", async () => {
    mock = await startMockEcw({ requireLogin: true }); // nobody clicks the link
    await assert.rejects(
      () => login({ emailWaitMs: 1_500 }),
      (e) => e instanceof SignInError && /email/.test(e.message),
    );
    assert.equal(mock.state.emailsSent, 1);
  });

  it("refuses to start without credentials (never types an empty password)", async () => {
    mock = await startMockEcw({ requireLogin: true });
    await assert.rejects(
      () => login({ password: undefined }),
      /ECW_USERNAME and ECW_PASSWORD/,
    );
    assert.equal(mock.state.failedLogins, 0);
  });

  it("logs in again after the session expires", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await login();
    mock.expireSessions();
    await login();
    assert.equal(mock.state.logins, 2);
  });

  it("never writes the password or username in its messages", async () => {
    mock = await startMockEcw({ requireLogin: true, confirmEmailAfterMs: 500 });
    await login();
    for (const m of logged) {
      assert.doesNotMatch(m, new RegExp(MOCK_ECW_LOGIN.password));
      assert.doesNotMatch(m, new RegExp(MOCK_ECW_LOGIN.username));
    }
  });
});
