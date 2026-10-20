// A fake GEHRIMed for testing run.js end to end — made-up data only.
//
// Mirrors the real structure (inspected 2026-10-19):
//   outer page → cross-origin app frame → nested "dashboardnx" frame that
//   covers the app's old menu; Bootstrap dropdowns whose items are
//   <li><a>…</a></li> (only the <a> reacts); leftover search criteria that must
//   be removed; 10 results per page with a "Per Page" <select>; rows with
//   View + caret <span> + Print/Download/Resend; #enter-password-dialog with
//   one password box and Submit, POSTing to /Encounter/Download; the download
//   is a password-protected PDF (or, with { download: "zip" }, an AES zip).
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sevenBin from "7zip-bin";
import { encryptPdf, writeBlankPdf } from "../src/archive/pdf.js";

const run = promisify(execFile);

/** 25 encounters signed on 10/13 (spans pages), 1 on 10/18. */
export const MOCK_DAYS = {
  "2026-10-13": Array.from({ length: 25 }, (_, i) => String(900000100 + i)),
  "2026-10-18": ["900000001"],
  // A normal note, a GEHRIMed test patient, a row with no first name, a normal note.
  "2026-10-14": ["900000201", "900000202", "900000203", "900000204"],
  // Seven broken rows in a row — the export should stop after 5.
  "2026-10-15": Array.from({ length: 7 }, (_, i) => String(900000301 + i)),
};

/** Encounters shown with GEHRIMed's visible "Test" badge (test patients). */
export const MOCK_TEST_PATIENT_IDS = ["900000202"];
/** Encounters whose First Name cell is empty (can't be named → must fail, not be guessed). */
export const MOCK_BROKEN_IDS = ["900000203", ...MOCK_DAYS["2026-10-15"]];

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/**
 * Made-up patient details for row `i`. Rows 3 and 4 are the same patient on
 * the same date of service (two encounters), to exercise the _2 suffix.
 */
export const mockPatient = (i) => {
  const p = i === 4 ? 3 : i;
  return {
    firstName: `PAT${LETTERS[p]}`,
    lastName: `TESTLAST${LETTERS[p]}`,
    dateOfBirth: `${(p % 12) + 1}/${(p % 27) + 1}/1940`,
    dateOfService: "10/12/2026",
  };
};

/** The file names billing should get for a day, in row order. */
export const expectedNames = (day) => {
  const used = new Map();
  return MOCK_DAYS[day].map((_, i) => {
    const m = mockPatient(i);
    const [dm, dd, dy] = m.dateOfBirth.split("/");
    const base = `Testlast${LETTERS[i === 4 ? 3 : i].toLowerCase()}Pat${LETTERS[i === 4 ? 3 : i].toLowerCase()}` +
      `_DOB${dm.padStart(2, "0")}.${dd.padStart(2, "0")}.${dy}_DOS10.12.2026`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return `${base}${n > 1 ? `_${n}` : ""}.pdf`;
  });
};

const dashHtml = `<!doctype html><html><body style="margin:0;background:#eef">
<nav><div class="nav-item"><div onclick="parent.openSearch()">Search</div></div><div class="nav-item"><div>Reports</div></div></nav>
<p>Unsigned Encounters (0 total)</p>
</body></html>`;

const dropdown = (id, label, items) => `
  <div class="btn-group">
    <a class="btn btn-default dropdown-toggle" data-bs-toggle="dropdown" id="${id}" onclick="toggleMenu(this)">${label}</a>
    <ul class="dropdown-menu hidden">${items.map((i) => `<li><a onclick="pick('${id}', this)">${i}</a></li>`).join("")}</ul>
  </div>`;

const appHtml = (days, wrongPromptFor, restoreDelayMs, rowCap) => `<!doctype html><html><head><style>
  .hidden{display:none}
  .dropdown-menu{list-style:none;margin:0;padding:4px 0;border:1px solid #999;background:#fff;position:absolute;z-index:20}
  .dropdown-menu:not(.hidden){animation:menu-open 300ms ease-out}
  @keyframes menu-open{from{transform:translateY(-12px)}to{transform:none}}
  .dropdown-menu li{padding:0;margin:0} .dropdown-menu a{display:block;padding:3px 10px;cursor:pointer}
  .btn-group{position:relative;display:inline-block}
  #dashboardnx{position:fixed;top:0;left:0;width:100%;height:100%;border:0;z-index:1}
  .modal{position:relative;z-index:10;background:#fff}
</style></head><body>
<div id="loading" class="hidden modal">Please wait, loading...</div>
<nav><div class="nav-item"><div onclick="openSearch()">Search</div></div></nav>
<iframe id="dashboardnx" scrolling="no" src="/dash" title="GEHRIMED Dashboard"></iframe>

<div id="simple-search-dialog" class="modal full hidden">
  <label>Search patients for:</label> <input id="SearchText" type="text"> <input id="simple-search" type="submit" class="btn btn-primary" value="Search">
  <a id="advanced-search" title="Advanced Search" class="btn btn-default dialog" onclick="openAdvanced()">Advanced Search</a>
  <a class="btn btn-default">Close</a>
</div>

<div id="search-dialog" class="modal full hidden">
  <label class="control-label bolder">Search:</label>
  ${dropdown("cat", "Patient", ["Patient", "Encounter", "Patient Notes"])}
  ${dropdown("field", "Last Name", ["Age", "Date of Service", "Date of Signature", "Encounter ID", "Last Name"])}
  ${dropdown("op", "Is", ["Is", "Is not"])}
  <input id="SearchValue" type="text" name="SearchValue" placeholder="Enter a text value" class="form-control">
  <input type="submit" class="btn btn-primary" value="Add" onclick="addCriteria()">
  <div id="criteria" class="hidden">
    <label>Search criteria:</label> <span id="pills"></span>
    <button class="btn btn-info remove-all-criteria" onclick="removeAll()">✕ Remove All Search Criteria</button>
  </div>
  <span id="count"></span>
  <table id="search-results" class="table-default knockout-table"><thead><tr><th colspan="100">Note: Displaying the first 500 results. Up to 10,000 results may be exported using the Export Results Button. Add search criteria to narrow your results.</th></tr><tr><th class="no-print"></th><th>Encounter ID</th><th>Last Name</th><th>First Name</th><th>Middle Name</th><th>Patient ID</th><th>Date of Birth</th><th>Date of Service</th><th>Seen By</th></tr></thead><tbody id="rows"></tbody></table><div id="no-results" style="display:none">No encounters found.</div>
  <div id="pager" class="hidden">Per Page <select id="per-page"><option>10</option><option>20</option><option>50</option><option>100</option><option>500</option></select>
    <ul class="pagination"></ul></div>
</div>

<div id="enter-password-dialog" class="modal medium hidden">
  <form id="pw-form" method="post" action="/Encounter/Download">
    <h4>Enter Password</h4>
    <p>Please enter a password below. This password will be used to encrypt the PDF.</p>
    <input id="IsPDF" type="hidden" name="IsPDF" value="true">
    <input id="EncounterID" type="hidden" name="EncounterID">
    <label>Password</label> <input id="Password" type="password" name="Password" class="form-control input-focus">
    <a class="btn btn-default" onclick="closePw()">Cancel</a> <input type="submit" class="btn btn-primary" value="Submit">
  </form>
</div>

<script>
const DAYS = ${JSON.stringify(days)};
const RESTORE_DELAY_MS = ${JSON.stringify(restoreDelayMs)};
const WRONG_PROMPT_FOR = ${JSON.stringify(wrongPromptFor ?? null)}; // test: prompt carries the wrong encounter
// Like the real site's "Displaying the first 500 results": never more rows than this, whatever Per Page says.
const ROW_CAP = ${JSON.stringify(rowCap)} ?? Infinity;
const P = ${JSON.stringify(Array.from({ length: 30 }, (_, i) => mockPatient(i)))};
const TEST = ${JSON.stringify(MOCK_TEST_PATIENT_IDS)};
const BROKEN = ${JSON.stringify(MOCK_BROKEN_IDS)};
const $ = (id) => document.getElementById(id);
const show = (el) => (typeof el === 'string' ? $(el) : el).classList.remove('hidden');
const hide = (el) => (typeof el === 'string' ? $(el) : el).classList.add('hidden');
const busy = (fn) => { show('loading'); setTimeout(() => { hide('loading'); fn(); }, 150); };
// Like the real site: criteria from an earlier search are kept but HIDDEN until
// a new criterion is added — then they all show up together.
let criteria = [{ field: 'Date of Signature', value: '2026-10-13' }, { field: 'Date of Signature', value: '2026-10-12' }];
let revealed = false;
let list = [];
function openSearch(){ busy(() => show('simple-search-dialog')); try { sessionStorage.setItem('restoreSearch', '1'); } catch {} }
// Like the real site (data-auto-refresh): after a reload, a Search window that
// was open is RESTORED by itself a moment later, covering the left menu.
try {
  if (sessionStorage.getItem('restoreSearch')) setTimeout(() => busy(() => show('simple-search-dialog')), RESTORE_DELAY_MS);
} catch {}
// Like the real site, leftover criteria (and the Remove All button) show up a
// moment after the window opens — not immediately.
function openAdvanced(){ busy(() => show('search-dialog')); }
function toggleMenu(t){
  const menu = t.nextElementSibling;
  menu.classList.toggle('hidden');
  menu.dataset.ready = '0';
  setTimeout(() => { menu.dataset.ready = '1'; }, 300); // still "opening" for 300ms
}
function pick(id, a){
  const menu = a.closest('.dropdown-menu');
  // Like the real site: a click while the menu is still opening does nothing,
  // and the dropdown's label updates a moment after a successful pick.
  if (menu.dataset.ready !== '1') return;
  hide(menu);
  const label = a.textContent;
  setTimeout(() => {
    $(id).textContent = label;
    // Like the real site: the value box switches to a date box a moment AFTER the label updates.
    if (id === 'field') setTimeout(() => { $('SearchValue').type = label.startsWith('Date') ? 'date' : 'text'; }, 600);
  }, 300);
}
function addCriteria(){
  if ($('cat').textContent !== 'Encounter') return;
  criteria.push({ field: $('field').textContent, value: $('SearchValue').value });
  revealed = true; // hidden leftover criteria show up now too
  // Like the real site: the category keeps "Encounter", the field resets.
  $('field').textContent = 'Last Name';
  $('SearchValue').type = 'text'; $('SearchValue').value = '';
  busy(render);
}
function removeAll(){
  criteria = []; revealed = true; busy(render);
  // Like the real site (2026-10-20): a moment after Remove All, the dropdown
  // menus are rebuilt — any open menu closes and its items are replaced.
  const rebuild = () => document.querySelectorAll('#search-dialog .dropdown-menu').forEach((m) => {
    const fresh = m.cloneNode(true);
    fresh.classList.add('hidden');
    fresh.querySelectorAll('a').forEach((a, i) => { a.onclick = m.querySelectorAll('a')[i].onclick; });
    m.replaceWith(fresh);
  });
  setTimeout(rebuild, 400);
  setTimeout(rebuild, 900);
  // ...and a couple of late rebuilds that land WHILE the script is picking,
  // to exercise its retry.
  setTimeout(rebuild, 1500);
  setTimeout(rebuild, 1800);
}
function render(){
  (criteria.length ? show : hide)('criteria');
  $('pills').innerHTML = criteria.map(c => '<div class="btn-group print"><button class="btn btn-default print manual-print"><strong>' + c.field + '</strong> <em>' + c.value + '</em></button><button class="btn btn-default remove-criteria"><i class="fa fa-times">×</i></button></div> ').join('');
  // Criteria are ANDed: two different dates match nothing.
  const dates = criteria.filter(c => c.field === 'Date of Signature').map(c => c.value);
  const ok = criteria.length > 0 && criteria.every(c => c.field === 'Date of Signature') && new Set(dates).size === 1;
  list = ok ? (DAYS[dates[0]] || []) : [];
  // Like the real site: with no matches, the count is EMPTY and the table says 'No encounters found.'
  $('count').textContent = !criteria.length ? 'Please enter search criteria.' : list.length ? 'Results: ' + list.length : '';
  $('no-results').style.display = criteria.length && !list.length ? '' : 'none';
  (list.length > 10 ? show : hide)('pager');
  drawRows();
}
$('per-page').onchange = () => busy(drawRows);
function drawRows(){
  const n = Math.min(Number($('per-page').value), ROW_CAP);
  $('rows').innerHTML = list.slice(0, n).map((id, i) =>
    '<tr><td><div class="btn-group dropright">' +
      '<a class="btn-xs btn btn-default dialog">View</a>' +
      '<span class="btn btn-default btn-xs dropdown-toggle" data-bs-toggle="dropdown" onclick="toggleMenu(this)"><span class="caret">▾</span></span>' +
      '<ul class="dropdown-menu pull-left hidden"><li><a class="dialog">Print</a></li>' +
      '<li><a class="dialog" onclick="askPw(\\'' + id + '\\', this)">Download</a></li>' +
      '<li><a class="action" onclick="resend(\\'' + id + '\\')">Resend</a></li></ul>' +
    '</div></td><td>' + id + ' <i>📄</i></td><td>' + P[i].lastName + '</td><td>' +
      // Like the real cell: a "Test" badge, visible only for test patients, then the first name.
      '<span class="label label-success" style="display:' + (TEST.includes(id) ? 'inline' : 'none') + '">Test</span>' +
      '<span>' + (BROKEN.includes(id) ? '' : P[i].firstName) + '</span></td><td></td><td>' + (100000 + i) +
    '</td><td>' + P[i].dateOfBirth + '</td><td>' + P[i].dateOfService + '</td><td>Provider, Test</td></tr>').join('');
}
function askPw(id, a){ hide(a.closest('.dropdown-menu')); $('EncounterID').value = WRONG_PROMPT_FOR === id ? '999999999' : id; $('Password').value = ''; show('enter-password-dialog'); }
function closePw(){ hide('enter-password-dialog'); }
$('pw-form').onsubmit = (e) => { if (!$('Password').value) { e.preventDefault(); return; } setTimeout(closePw, 50); };
function resend(id){ fetch('/resend?id=' + id); }
// Like the real site: Escape closes the search window (and hides every result row).
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hide('search-dialog'); hide('simple-search-dialog'); } });
</script></body></html>`;

const readForm = (req) =>
  new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(new URLSearchParams(body)));
  });

/** Fake credentials accepted by the mock's login. */
export const MOCK_LOGIN = { username: "test.user@example.com", password: "Mock#Pass9" };

const usernamePage = (authUrl) => `<!doctype html><title>GEHRIMED</title>
<label class="form-label">Username or Email</label>
<input id="userName" name="username" type="text" class="form-control">
<button class="btn btn-primary" onclick="location.href='${authUrl}?u=' + encodeURIComponent(document.getElementById('userName').value)">Next</button>`;

const oktaPage = (username, error) => `<!doctype html><title>Netsmart Technologies (Netsmart IAM) - Sign In</title>
<form id="form32" class="primary-auth-form o-form" action="/" method="post">
  <h2 class="okta-form-title o-form-head">Sign In</h2>
  <div class="o-form-error-container">${error ? `<p>${error}</p>` : ""}</div>
  <label>Netsmart ID</label> <input id="okta-signin-username" name="username" type="text" value="${username.replace(/"/g, "")}">
  <label>Password</label> <input id="okta-signin-password" name="password" type="password">
  <input id="okta-signin-submit" type="submit" class="button button-primary" value="Sign In">
</form>`;

/** @param {{ download?: "pdf" | "zip", requireLogin?: boolean, rowCap?: number }} options */
export const startMock = async ({ download = "pdf", requireLogin = false, wrongPromptFor = null, restoreDelayMs = 1_200, rowCap = null } = {}) => {
  // Per-instance copy so tests can add encounters while the mock runs ("newly signed" notes).
  const days = structuredClone(MOCK_DAYS);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "mock-gehrimed-"));
  const state = { resends: 0, downloads: 0 };

  const makeDownload = async (id, password) => {
    const dir = path.join(work, id);
    await fs.mkdir(dir, { recursive: true });
    const plain = path.join(dir, `plain_${id}.pdf`);
    writeBlankPdf(plain);
    const locked = path.join(dir, `Note_${id}.pdf`);
    encryptPdf(plain, locked, password);
    await fs.rm(plain);
    if (download === "pdf") return { body: await fs.readFile(locked), type: "application/pdf", ext: ".pdf" };
    const zip = path.join(work, `${id}.zip`);
    await run(sevenBin.path7za, ["a", "-tzip", zip, locked, `-p${password}`, "-mem=AES256", "-y"]);
    return { body: await fs.readFile(zip), type: "application/zip", ext: ".zip" };
  };

  const appServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/dash") {
      res.writeHead(200, { "content-type": "text/html" }).end(dashHtml);
    } else if (url.pathname === "/app") {
      res.writeHead(200, { "content-type": "text/html" }).end(appHtml(days, wrongPromptFor, restoreDelayMs, rowCap));
    } else if (url.pathname === "/Encounter/Download" && req.method === "POST") {
      const form = await readForm(req);
      const { body, type, ext } = await makeDownload(form.get("EncounterID"), form.get("Password"));
      state.downloads++;
      res.writeHead(200, {
        "content-type": type,
        // Real GEHRIMed filenames may contain patient names; the script must not rely on this.
        "content-disposition": `attachment; filename="TESTLAST_TESTFIRST_${form.get("EncounterID")}${ext}"`,
      }).end(body);
    } else if (url.pathname === "/resend") {
      state.resends++;
      res.writeHead(200).end("resent");
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((r) => appServer.listen(0, "127.0.0.1", r));
  const appPort = appServer.address().port;

  // Fake Netsmart Okta sign-in, on its own port (= its own origin).
  // Cookies ignore ports, so a cookie set here is seen by the outer page too.
  let outerUrl;
  state.logins = 0;
  state.failedLogins = 0;
  const authServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") {
      const form = await readForm(req);
      if (form.get("username") === MOCK_LOGIN.username && form.get("password") === MOCK_LOGIN.password) {
        state.logins++;
        res.writeHead(302, { "set-cookie": "mock_session=1; Path=/", location: outerUrl }).end();
      } else {
        state.failedLogins++;
        res.writeHead(200, { "content-type": "text/html" })
          .end(oktaPage(form.get("username") || "", "Unable to sign in"));
      }
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(oktaPage(url.searchParams.get("u") || ""));
    }
  });
  await new Promise((r) => authServer.listen(0, "127.0.0.1", r));
  const authUrl = `http://127.0.0.1:${authServer.address().port}/`;

  // Outer page on a different port = different origin, like the real site.
  const outerServer = http.createServer((req, res) => {
    // Like the real dashboard: something on the page keeps loading for a long
    // time, so the browser's "load" event comes very late (45 s here).
    if (req.url === "/slow-asset") {
      const t = setTimeout(() => res.writeHead(200, { "content-type": "image/gif" }).end(), 45_000);
      res.on("close", () => clearTimeout(t));
      return;
    }
    const loggedIn = /(?:^|;\s*)mock_session=1/.test(req.headers.cookie || "");
    res.writeHead(200, { "content-type": "text/html" }).end(
      requireLogin && !loggedIn
        ? usernamePage(authUrl)
        : `<!doctype html><title>GEHRIMED</title><iframe id="gehrimed-iframe" src="http://127.0.0.1:${appPort}/app" style="width:100%;height:95vh"></iframe>` +
            `<img src="/slow-asset" style="display:none">`,
    );
  });
  await new Promise((r) => outerServer.listen(0, "127.0.0.1", r));
  outerUrl = `http://127.0.0.1:${outerServer.address().port}/`;

  return {
    url: outerUrl,
    /** Simulate a note being signed: it appears in the next search for that day. */
    addEncounter: (day, id) => (days[day] ??= []).push(id),
    state,
    close: async () => {
      for (const s of [appServer, outerServer, authServer]) s.closeAllConnections(); // drop the slow request
      await Promise.all([appServer, outerServer, authServer].map((s) => new Promise((r) => s.close(r))));
      await fs.rm(work, { recursive: true, force: true });
    },
  };
};
