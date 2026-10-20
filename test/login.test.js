// Automatic login: GEHRIMed username screen → Netsmart Okta sign-in → dashboard.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MOCK_LOGIN, startMock } from "./mock-gehrimed.js";

describe("automatic login (mock GEHRIMed + mock Okta)", { timeout: 120_000 }, () => {
  let mock;
  const saved = {};
  const setEnv = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  before(async () => {
    mock = await startMock({ requireLogin: true });
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await mock.close();
  });

  // session.js reads GEHRIMED_URL when it's imported, so set it first.
  const loadSession = async () => {
    setEnv({ GEHRIMED_URL: mock.url });
    return import(`../src/gehrimed/session.js?t=${Date.now()}`);
  };

  it("logs in with GEHRIMED_USERNAME / GEHRIMED_PASSWORD and reaches the dashboard", async () => {
    const { openGehrimed } = await loadSession();
    setEnv({ GEHRIMED_USERNAME: MOCK_LOGIN.username, GEHRIMED_PASSWORD: MOCK_LOGIN.password });
    const { browser } = await openGehrimed({ headless: true });
    await browser.close();
    assert.equal(mock.state.logins, 1);
  });

  it("fails clearly on a wrong password — without printing the password", async () => {
    const { openGehrimed } = await loadSession();
    setEnv({ GEHRIMED_USERNAME: MOCK_LOGIN.username, GEHRIMED_PASSWORD: "Wrong#Pass1" });
    let browser;
    await assert.rejects(
      (async () => ({ browser } = await openGehrimed({ headless: true })))(),
      (e) => /Netsmart sign-in failed: Unable to sign in/.test(e.message) && !e.message.includes("Wrong#Pass1"),
    );
    await browser?.close();
    assert.equal(mock.state.failedLogins, 1);
  });

  it("refuses to run headless without credentials", async () => {
    const { openGehrimed } = await loadSession();
    setEnv({ GEHRIMED_USERNAME: undefined, GEHRIMED_PASSWORD: undefined });
    await assert.rejects(openGehrimed({ headless: true }), /needs GEHRIMED_USERNAME and GEHRIMED_PASSWORD/);
  });
});
