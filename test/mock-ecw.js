// A fake eCW Patient Lookup for tests — made-up patients only.
//
// Mirrors the real screen (mapped on the test patient, 2026-10-21):
//   the patient-search icon (a.icon-usersearch) opens the "Patient Lookup"
//   window (#pt-lookup-modal-dialog); a search-type menu shows "Name" and its
//   items are <li><a> (only the <a> reacts), including "External MRN";
//   #searchText; Search and Cancel buttons; the column headers and the result
//   rows are two SEPARATE tables (rows in #rule-table2, matched to headers by
//   position); name cells carry the name in a tooltip; every row ends with a
//   "Delete Patient" icon (i.icdelet) that must never be clicked.
//
// How the search really works (read from eCW's own code, 2026-10-23):
//   eCW searches BY ITSELF: every change to #searchText that leaves at least
//   2 characters clears the results at once, then 500 ms later POSTs
//   getPatients.jsp with the text as `primarySearchValue`. The Search button
//   is only for the practice's custom "S …" fields; for ordinary types like
//   External MRN it stays disabled. Setting the same text again is no change,
//   so it doesn't search. The first result row is selected automatically.
//   `searchDelayMs` is how long the fake eCW takes to answer.
import crypto from "node:crypto";
import http from "node:http";

/** Made-up patients. Any External MRN not listed here finds nothing. */
export const MOCK_ECW_PATIENTS = [
  // One chart for this MRN: the normal case.
  {
    externalMrn: "GM100001",
    lastName: "TESTLASTA",
    firstName: "PATA",
    dob: "01/02/1940",
    acctNo: "50001",
  },
  // Two charts share this MRN (a duplicate chart): must come out as "several".
  {
    externalMrn: "GM100002",
    lastName: "TESTLASTB",
    firstName: "PATB",
    dob: "02/03/1941",
    acctNo: "50002",
  },
  {
    externalMrn: "GM100002",
    lastName: "TESTLASTB",
    firstName: "PATB",
    dob: "02/03/1941",
    acctNo: "50003",
  },
  // Hyphen and space in the last name, as eCW may show them.
  {
    externalMrn: "GM100003",
    lastName: "TEST-LAST C",
    firstName: "PATC",
    dob: "03/04/1942",
    acctNo: "50004",
  },
];

// The real menu's items, in the real order (the eCW "S …" custom items left out).
const SEARCH_TYPES = [
  "Name",
  "DOB",
  "SSN",
  "Acct No (MRN)",
  "Phone (C/H/W)",
  "Guarantor Name",
  "Guarantor Phone",
  "Subscriber No",
  "External MRN",
  "Previous Name",
];

// The real 13 columns, in the real order. Rows must have the same 13 cells.
const HEADERS = [
  "",
  "",
  "Pt. Alerts",
  "Last Name",
  "First Name",
  "Middle Name",
  "DOB",
  "Sex",
  "Acct No (MRN)",
  "Phone (C/H/W)",
  "Guarantor Name",
  "Last Appt",
  "",
];

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const pageHtml = () => `<!doctype html>
<html><head><title>eCW (Mock, User)</title>
<style>.hidden{display:none} .modal{border:1px solid #888;padding:8px;margin:8px} td,th{border:1px solid #ccc;padding:2px 6px}</style>
</head><body>
<header>
  <a class="cursor icon-usersearch userbtn pull-left" type="patient" title="Action" onclick="openLookup()">[patient search]</a>
</header>
<main><h3>Office Visits</h3></main>

<div class="modal hidden" id="patient-lookup-screen">
  <div class="modal-dialog" id="pt-lookup-modal-dialog">
    <div class="modal-header">
      <button type="button" id="patientSearchBtn1" title="ESC" onclick="closeLookup()">×</button>
      <span class="modal-title">Patient Lookup</span>
    </div>
    <div class="col-sm-12 nopadding">
      <label>Primary Search</label>
      <input type="text" id="searchText" placeholder="Last Name, First Name">
      <div class="dropdown">
        <div class="cursorpoint" id="searchBy" onclick="toggleMenu()">Name</div>
        <ul class="dropdown-menu dropmenu pull-left hidden" id="searchByMenu">
          ${SEARCH_TYPES.map((t) => `<li class="ng-scope"><a class="ng-scope" onclick="setSearchBy(this)">${t}</a></li>`).join("")}
        </ul>
      </div>
    </div>
    <button type="button" id="patientSearchBtn10201" title="ALT + S" disabled onclick="search()">Search</button>
    <button type="button" id="patientSearchBtn10" title="ALT + C" onclick="closeLookup()">Cancel</button>
    <table class="table table-bordered blue-fade-table"><thead><tr>${HEADERS.map((h) => `<th>${h}</th>`).join("")}</tr></thead></table>
    <table class="table table-bordered blue-fade-table" id="rule-table2"><tbody></tbody></table>
  </div>
</div>

<script>
  const $ = (s) => document.querySelector(s);
  const esc = ${escapeHtml.toString()};
  const openLookup = () => $("#patient-lookup-screen").classList.remove("hidden");
  const closeLookup = () => $("#patient-lookup-screen").classList.add("hidden");
  const toggleMenu = () => $("#searchByMenu").classList.toggle("hidden");
  const setSearchBy = (a) => {
    $("#searchBy").textContent = a.textContent;
    $("#searchText").placeholder = a.textContent === "Name" ? "Last Name, First Name" : "";
    $("#searchByMenu").classList.add("hidden");
  };
  const row = (p) => \`<tr class="ng-scope" ng-repeat="patient in patientList track by patient.id">
      <td class="w4p"></td><td class="nopadding w4p"></td><td class="w13p nopadding"></td>
      <td class="w17p patientName"><span title="Launch Patient Hub. Last Name: \${esc(p.lastName)}">\${esc(p.lastName)}</span></td>
      <td class="w14p patientName"><span title="Launch Patient Hub. First Name: \${esc(p.firstName)}">\${esc(p.firstName)}</span></td>
      <td class="w8p"></td><td class="w10p">\${esc(p.dob)}</td><td class="w5p">U</td><td class="w12p">\${esc(p.acctNo)}</td>
      <td class="wd21pr"></td><td class="wd21pr"></td><td class="w14p"></td>
      <td class="w5p"><span class="pull-left bsquare"></span><i class="icon icdelet" title="Delete Patient" onclick="deletePatient()"></i></td>
    </tr>\`;
  const results = () => $("#rule-table2 tbody");
  const search = async () => {
    const res = await fetch("/mobiledoc/jsp/catalog/xml/getPatients.jsp", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SearchBy: $("#searchBy").textContent, primarySearchValue: $("#searchText").value }),
    });
    const patients = await res.json();
    results().innerHTML = patients.map(row).join("");
    results().querySelector("tr")?.classList.add("highlight"); // eCW selects the first result
  };
  const deletePatient = () => fetch("/api/delete-patient", { method: "POST" });
  // Like real eCW: every change that leaves 2+ characters clears the results,
  // then searches by itself 500 ms later. (The Search button stays disabled.)
  let typingTimer;
  $("#searchText").addEventListener("input", () => {
    if ($("#searchText").value.length < 2) return;
    results().innerHTML = "";
    clearTimeout(typingTimer);
    typingTimer = setTimeout(search, 500);
  });
</script>
</body></html>`;

// ---------------------------------------------------------------------------
// Login (mapped on live eCW, 2026-10-23). Three screens at the real addresses:
//   1. newLogin.jsp — username #doctorID, Next #nextStep (form#loginForm)
//   2. getPwdPage   — password #passwordField, Log In #Login (posts to
//      processLoginRequest; the form carries Cloudflare "turnstileResponse" /
//      "isCaptcha" fields, not active when mapped)
//   3. OTPVerification.jsp — "eClinicalWorks sent a notification to your
//      email. Please confirm to login." + Resend OTP #resendOtpBtn. Nothing to
//      type: the person clicks a link in the email and the page moves on to
//      index.jsp by itself.
// Assumption (never tried on live eCW, to avoid locking the account): a wrong
// password shows the password page again, with an error.
// ---------------------------------------------------------------------------

/** Made-up credentials the fake accepts. */
export const MOCK_ECW_LOGIN = { username: "mockuser", password: "mock-password-1" };

const PATHS = {
  home: "/mobiledoc/jsp/webemr/index.jsp",
  login: "/mobiledoc/jsp/webemr/login/newLogin.jsp",
  password: "/mobiledoc/jsp/webemr/login/authenticate/getPwdPage",
  processLogin: "/mobiledoc/jsp/webemr/login/authenticate/processLoginRequest",
  otp: "/mobiledoc/jsp/webemr/login/OTPVerification.jsp",
  otpStatus: "/mock/otp-status", // the fake's stand-in for how the real page learns the email was confirmed
  resendOtp: "/mock/resend-otp",
};

const loginPageHtml = () => `<!doctype html>
<html><head><title>Web EMR Login Page</title></head><body>
<form id="loginForm" method="post" action="${PATHS.password}">
  <label for="doctorID">Enter username to continue</label>
  <input type="text" id="doctorID" name="doctorID" autocomplete="off">
  <input type="submit" id="nextStep" value="Next">
</form>
<button id="btnDownloadPlugin" onclick="downloadStartupexe()">Download Plug-in</button>
</body></html>`;

const passwordPageHtml = (username, error) => `<!doctype html>
<html><head><title>Web EMR Login Page</title></head><body>
<form id="loginForm" method="post" action="${PATHS.processLogin}">
  <input type="hidden" name="doctorID" value="${escapeHtml(username)}">
  <input type="hidden" name="turnstileResponse" value="">
  <input type="hidden" name="isCaptcha" value="">
  <label for="passwordField">Enter Password to continue</label>
  <input type="password" id="passwordField" name="passwordField" autocomplete="off">
  <button type="button">Show</button>
  <input type="submit" id="Login" value="Log In">
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
</form>
<a href="${PATHS.login}">Sign in with a different account</a> <a href="#">Forgot password?</a>
</body></html>`;

const otpPageHtml = () => `<!doctype html>
<html><head><title>Web EMR OTP Page</title></head><body>
<p>eClinicalWorks sent a notification to your email. Please confirm to login.</p>
<button id="resendOtpBtn" onclick="fetch('${PATHS.resendOtp}', { method: 'POST' })">Resend OTP</button>
<script>
  // Moves on by itself once the email link has been clicked.
  setInterval(async () => {
    const res = await fetch("${PATHS.otpStatus}");
    if ((await res.json()).confirmed) location.href = "${PATHS.home}";
  }, 500);
</script>
</body></html>`;

const readCookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(/;\s*/)
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
  );

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

/**
 * Starts the fake eCW on a random free port.
 * @param {{ patients?: object[], searchDelayMs?: number, requireLogin?: boolean, confirmEmailAfterMs?: number | null }} [options]
 *   searchDelayMs: how long the fake takes to answer a search
 *   requireLogin: false (default) opens straight on the home screen, for the search tests
 *   confirmEmailAfterMs: "click" the email link this long after a correct password (null = only via confirmEmail())
 */
export const startMockEcw = async ({
  patients = MOCK_ECW_PATIENTS,
  searchDelayMs = 300,
  requireLogin = false,
  confirmEmailAfterMs = null,
} = {}) => {
  // What the browser did — tests check these (e.g. deletes must stay 0).
  const state = { searches: [], deletes: 0, logins: 0, failedLogins: 0, emailsSent: 0 };
  const sessions = new Set(); // logged-in session tokens
  const waitingForEmail = new Map(); // OTP token → has the email link been clicked?

  const confirmEmail = () => {
    for (const token of waitingForEmail.keys()) waitingForEmail.set(token, true);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const cookies = readCookies(req);
    const html = (body) => res.writeHead(200, { "content-type": "text/html" }).end(body);
    const redirect = (to, cookie) =>
      res.writeHead(302, { location: to, ...(cookie && { "set-cookie": `${cookie}; Path=/` }) }).end();

    if (url.pathname === "/") {
      redirect(PATHS.home);
    } else if (url.pathname === PATHS.home) {
      if (requireLogin && !sessions.has(cookies.ecw_session)) redirect(PATHS.login);
      else html(pageHtml());
    } else if (url.pathname === PATHS.login) {
      html(loginPageHtml());
    } else if (url.pathname === PATHS.password && req.method === "POST") {
      html(passwordPageHtml(new URLSearchParams(await readBody(req)).get("doctorID") ?? ""));
    } else if (url.pathname === PATHS.processLogin && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const username = form.get("doctorID") ?? "";
      if (username === MOCK_ECW_LOGIN.username && form.get("passwordField") === MOCK_ECW_LOGIN.password) {
        state.logins++;
        state.emailsSent++;
        const token = crypto.randomUUID();
        waitingForEmail.set(token, false);
        if (confirmEmailAfterMs !== null) setTimeout(confirmEmail, confirmEmailAfterMs);
        redirect(PATHS.otp, `ecw_otp=${token}`);
      } else {
        state.failedLogins++;
        html(passwordPageHtml(username, "Invalid username or password"));
      }
    } else if (url.pathname === PATHS.otp) {
      if (waitingForEmail.has(cookies.ecw_otp)) html(otpPageHtml());
      else redirect(PATHS.login);
    } else if (url.pathname === PATHS.otpStatus) {
      const confirmed = waitingForEmail.get(cookies.ecw_otp) === true;
      const headers = { "content-type": "application/json" };
      if (confirmed) {
        waitingForEmail.delete(cookies.ecw_otp);
        const session = crypto.randomUUID();
        sessions.add(session);
        headers["set-cookie"] = `ecw_session=${session}; Path=/`;
      }
      res.writeHead(200, headers).end(JSON.stringify({ confirmed }));
    } else if (url.pathname === PATHS.resendOtp && req.method === "POST") {
      state.emailsSent++;
      res.writeHead(200).end();
    } else if (url.pathname === "/mobiledoc/jsp/catalog/xml/getPatients.jsp" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const by = form.get("SearchBy");
      const q = (form.get("primarySearchValue") ?? "").trim();
      state.searches.push({ by, q });
      const found = by === "External MRN" ? patients.filter((p) => p.externalMrn === q) : [];
      setTimeout(
        () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(found)),
        searchDelayMs,
      );
    } else if (
      url.pathname === "/api/delete-patient" &&
      req.method === "POST"
    ) {
      state.deletes++;
      res.writeHead(200).end();
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}${PATHS.home}`,
    state,
    /** Simulates the person clicking the link in eCW's login email. */
    confirmEmail,
    /** Simulates eCW ending every session (timeout): the next page load goes to the login page. */
    expireSessions: () => sessions.clear(),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
};
