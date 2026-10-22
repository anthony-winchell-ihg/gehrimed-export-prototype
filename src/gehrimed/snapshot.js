// Writes a sanitized outline of GEHRIMed's page structure for debugging
// selectors — WITHOUT patient data:
//   • only controls are listed (buttons, links, inputs, dropdowns, menu items,
//     labels, table headers) — never free text
//   • nothing inside table bodies (that's where patient rows live)
//   • the dashboard/scheduler frames are skipped (patient lists)
//   • input values are never read; only type/name/placeholder
//   • frame URLs are cut to origin + first path segment (no session tokens)
import fs from "node:fs/promises";
import path from "node:path";

const SKIP_FRAMES = /^(dashboardnx|scheduler-nx)$/i;

const outlineInFrame = () => {
  const CONTROL = [
    "button",
    "a",
    "input",
    "select",
    "option",
    "label",
    "th",
    "textarea",
    '[role="button"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="dialog"]',
    ".dropdown-toggle",
    ".dropdown-item",
    ".dropdown-menu",
    ".btn",
    ".modal",
    "[data-toggle]",
    "[data-bs-toggle]",
  ].join(",");
  const short = (s, n = 50) =>
    (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      cs.visibility !== "hidden" &&
      cs.display !== "none"
    );
  };
  // Inside table rows (patient data!) we keep only structure: tag + class +
  // role, for the first 2 rows, and text only for short button/menu labels
  // with no digits (e.g. "View", "Download"). Everything else is dropped.
  const ROW_CONTROL =
    'button, [role="button"], .btn, .dropdown-toggle, .dropdown-item, [role="menuitem"], ' +
    '.dropdown-menu a, [role="menu"] a, .menu-list a';
  const safeLabel = (s) => {
    const t = short(s, 20);
    return t && !/\d/.test(t) && t.split(" ").length <= 2 ? t : "";
  };
  const rowIndex = (el) => {
    const tr = el.closest("tbody tr");
    if (!tr) return -1;
    return [...tr.parentElement.children].indexOf(tr);
  };

  const out = [];
  for (const el of document.querySelectorAll(CONTROL)) {
    const tag = el.tagName.toLowerCase();
    const inRow = !!el.closest("tbody") && tag !== "th";
    if (inRow) {
      if (rowIndex(el) > 1) continue; // first two rows only
      const attrs = [];
      for (const a of ["role", "type", "data-toggle", "data-bs-toggle"]) {
        const v = el.getAttribute(a);
        if (v) attrs.push(`${a}="${short(v, 30)}"`);
      }
      const cls = short(String(el.className || ""), 60);
      if (cls) attrs.push(`class="${cls}"`);
      const label = el.matches(ROW_CONTROL)
        ? safeLabel(el.innerText || el.textContent)
        : "";
      out.push(
        `${isVisible(el) ? "V" : "-"} [row ${rowIndex(el) + 1}] <${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${label ? " " + JSON.stringify(label) : ""}`,
      );
      continue;
    }
    const attrs = [];
    for (const a of [
      "id",
      "role",
      "type",
      "name",
      "placeholder",
      "title",
      "aria-label",
      "data-toggle",
      "data-bs-toggle",
    ]) {
      const v = el.getAttribute(a);
      if (v) attrs.push(`${a}="${short(v, 40)}"`);
    }
    const cls = short(String(el.className || ""), 60);
    if (cls) attrs.push(`class="${cls}"`);
    const text =
      tag === "input" || tag === "textarea" || tag === "select"
        ? ""
        : short(el.innerText || el.textContent, 50);
    const depth = (() => {
      let d = 0;
      for (let p = el.parentElement; p; p = p.parentElement) d++;
      return d;
    })();
    out.push(
      `${isVisible(el) ? "V" : "-"} ${"  ".repeat(Math.min(depth, 12))}<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${text ? " " + JSON.stringify(text) : ""}`,
    );
  }
  return out;
};

const frameLabel = (frame) => {
  let where;
  try {
    const u = new URL(frame.url());
    where = `${u.origin}/${u.pathname.split("/").filter(Boolean)[0] ?? ""}`;
  } catch {
    where = "(blank)";
  }
  return `${where}${frame.name() ? ` name="${frame.name()}"` : ""}`;
};

/** Saves a snapshot into `outputDir` (a debug folder) and returns its path. */
export const saveSnapshot = async (page, outputDir, reason) => {
  const lines = [
    `Snapshot: ${reason}`,
    `Taken: ${new Date().toISOString()}`,
    "V = visible, - = hidden",
    "",
  ];
  for (const frame of page.frames()) {
    lines.push(`=== frame ${frameLabel(frame)}`);
    if (SKIP_FRAMES.test(frame.name())) {
      lines.push(
        "  (skipped — dashboard/scheduler frame, contains patient lists)",
        "",
      );
      continue;
    }
    const outline = await frame
      .evaluate(outlineInFrame)
      .catch((e) => [`  (could not read: ${e.message.split("\n")[0]})`]);
    lines.push(...outline, "");
  }
  const dir = outputDir; // a debug folder — never the Teams folder
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`,
  );
  await fs.writeFile(file, lines.join("\n"), "utf8");
  return file;
};
