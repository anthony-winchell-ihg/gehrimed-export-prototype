// Helpers for clicking around GEHRIMed's UI.
//
// GEHRIMed is built from nested iframes: the outer page → the app frame
// (secure.gehrimed.com) → a "dashboardnx" frame layered on top of the app's
// own, older menu. The same label can exist in several frames, and the one
// in a shallower frame is often *covered* by a deeper one. So every lookup
// here searches all frames, deepest first, and only accepts an element that
// is visible and actually clickable (nothing on top of it).

const depth = (frame) => {
  let d = 0;
  for (let f = frame.parentFrame(); f; f = f.parentFrame()) d++;
  return d;
};

/** All frames on the page, deepest first. */
export const framesDeepestFirst = (page) =>
  [...page.frames()].sort((a, b) => depth(b) - depth(a));

const pollFrames = async (page, timeout, what, test, build) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const frame of framesDeepestFirst(page)) {
      const found = await test(frame).catch(() => null);
      if (found) return found;
    }
    if (Date.now() > deadline) {
      const details = build ? await describeMatches(page, build) : "";
      throw new Error(
        `Timed out after ${timeout / 1000}s waiting for ${what}${details}`,
      );
    }
    await page.waitForTimeout(250);
  }
};

// For error messages: per frame, what the lookup matched. Frame URLs are cut
// to origin + first path segment so session tokens never get printed.
const describeMatches = async (page, build) => {
  const lines = [];
  for (const frame of framesDeepestFirst(page)) {
    let where;
    try {
      const u = new URL(frame.url());
      where = `${u.origin}/${u.pathname.split("/").filter(Boolean)[0] ?? ""}`;
    } catch {
      where = "(blank frame)";
    }
    const name = frame.name() ? ` name="${frame.name()}"` : "";
    const matches = build(frame);
    const n = await matches.count().catch(() => 0);
    const found = [];
    for (let i = 0; i < Math.min(n, 4); i++) {
      const m = matches.nth(i);
      const info = await m
        .evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          cls: (el.className && String(el.className).slice(0, 40)) || "",
        }))
        .catch(() => null);
      const visible = await m.isVisible().catch(() => false);
      let clickable = false;
      if (visible)
        clickable = await m.click({ trial: true, timeout: 500 }).then(
          () => true,
          () => false,
        );
      if (info) {
        found.push(
          `<${info.tag}${info.role ? ` role=${info.role}` : ""}${info.cls ? ` class="${info.cls}"` : ""}> ` +
            `${visible ? "visible" : "hidden"}${visible ? (clickable ? ", clickable" : ", covered/not clickable") : ""}`,
        );
      }
    }
    lines.push(
      `  frame ${where}${name}: ${n} match(es)${found.length ? "\n    " + found.join("\n    ") : ""}`,
    );
  }
  return `\nWhat each frame contains for that lookup:\n${lines.join("\n")}`;
};

/**
 * Finds a visible element in any frame. `build(frame)` returns a locator.
 * Use for things you read or wait on, not click.
 */
export const findVisible = (page, build, what, { timeout = 30_000 } = {}) =>
  pollFrames(
    page,
    timeout,
    what,
    async (frame) => {
      const loc = build(frame).locator("visible=true").first();
      return (await loc.isVisible()) ? loc : null;
    },
    build,
  );

/**
 * Finds an element in any frame that can actually be clicked right now.
 * `click({ trial: true })` runs Playwright's checks (visible, enabled,
 * not covered by something else) without clicking.
 */
export const findClickable = (page, build, what, { timeout = 30_000 } = {}) =>
  pollFrames(
    page,
    timeout,
    what,
    async (frame) => {
      const candidates = build(frame).locator("visible=true");
      const n = Math.min(await candidates.count(), 5);
      for (let i = 0; i < n; i++) {
        const loc = candidates.nth(i);
        try {
          await loc.click({ trial: true, timeout: 750 });
          return loc;
        } catch {
          // covered or not ready — try the next candidate / frame
        }
      }
      return null;
    },
    build,
  );

export const click = async (page, build, what, opts) =>
  (await findClickable(page, build, what, opts)).click();

/** Click the element whose visible text is exactly `text`. */
export const clickText = (page, text, opts) =>
  click(page, (f) => f.getByText(text, { exact: true }), `"${text}"`, opts);

/**
 * A clickable control labelled exactly `name`: a real <button>, a link, or
 * any element with that exact text (GEHRIMed styles some <a>/<div>s as buttons).
 */
export const control = (frame, name) =>
  frame
    .getByRole("button", { name, exact: true })
    .or(frame.getByRole("link", { name, exact: true }))
    .or(frame.getByText(name, { exact: true }));

/** Click a control labelled exactly `name` (button, link, or styled element). */
export const clickButton = (page, name, opts) =>
  click(page, (f) => control(f, name), `"${name}"`, opts);

/**
 * Dropdown toggles show their current value plus a caret, e.g. "Patient ▾".
 * Matches the label, ignoring trailing caret characters.
 */
export const clickDropdown = (page, label, opts) =>
  click(page, (f) => dropdownToggle(f, label), `dropdown "${label}"`, opts);

// A dropdown toggle may be a <button>, <a>, or <div>/<span> with a dropdown
// class. Its text is the current value plus an optional caret or hidden
// "Toggle Dropdown" text — but nothing else (so "Patient Census" won't match).
const dropdownToggle = (frame, label) =>
  frame
    .locator(
      'button, a, [role="button"], .dropdown-toggle, .btn, [data-toggle="dropdown"], [data-bs-toggle="dropdown"]',
    )
    .filter({
      hasText: new RegExp(
        `^\\s*${escapeRegex(label)}(\\W|toggle dropdown)*$`,
        "i",
      ),
    });

/**
 * Click a dropdown menu item. In GEHRIMed each item is <li><a>label</a></li>
 * and only the <a> reacts, so target the link, not the list item.
 */
export const menuItem = (scope, label) =>
  scope
    .locator(".dropdown-menu a, [role='menu'] a, [role='menuitem']")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegex(label)}\\s*$`) });

export const clickMenuItem = (page, label, opts) =>
  click(page, (f) => menuItem(f, label), `menu item "${label}"`, opts);

/** Prints progress, so a failure or a hang shows where it happened. */
export const step = (msg) => console.log(`   · ${msg}`);

/** Wait until no frame shows GEHRIMed's "Please wait, loading..." overlay. */
export const waitForIdle = async (page, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  await page.waitForTimeout(200); // give the overlay a moment to appear
  for (;;) {
    let busy = false;
    for (const frame of page.frames()) {
      const overlay = frame
        .getByText("Please wait, loading...")
        .locator("visible=true");
      if ((await overlay.count().catch(() => 0)) > 0) busy = true;
    }
    if (!busy) return;
    if (Date.now() > deadline)
      throw new Error("GEHRIMed stayed on 'Please wait, loading...'");
    await page.waitForTimeout(250);
  }
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
