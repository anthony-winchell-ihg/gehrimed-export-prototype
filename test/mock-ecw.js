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
//
// Opening a patient (read from eCW's code on the test patient, 2026-10-27):
//   the Patient Hub button (#patientSearchBtn11) opens the SELECTED row's
//   patient; before the Hub, eCW may ask: "partially merged data — are you
//   sure?", an inactive / merge-source prompt, or "export or link this patient
//   to eEHX?" (Yes = a write). The Hub (#patient_hub) shows the External MRN in
//   [ng-bind="PatientHubInfo.mrn"] and the DOB in
//   [ng-bind="PatientHubInfo.dateOfBirth"] (MM/DD/YYYY); the name is cut at 18
//   characters. Hub → #letterDropDown → "Patient Doc - Web Mode" opens
//   #modalPatientDocs: folders a#pt_<id> labelled "Name(count)" (Chart
//   Documents = pt_2), Add Description #addDescription (ticked), Add Local
//   #patientdocsBtn4 → hidden #fileUpload. No folder selected → "Please select
//   a category." A PDF first gets the "PDF Flatten" warning (OK uploads, Cancel
//   doesn't; a "Don't show this message again" box can switch it off for the
//   user — then choosing the file uploads at once). The document's name in eCW
//   is the uploaded file's name without ".pdf".
// Assumptions not yet seen on live eCW (check at the test pass): the prompts'
//   exact markup (here: standard bootbox dialogs with Yes/No), how the Hub
//   marks an inactive patient ("(Inactive)" after the name), the "Document
//   Details" window after an upload, and how the upload request looks.
import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";

/**
 * Made-up patients. Any External MRN not listed here finds nothing.
 * `id` is eCW's own internal patient ID. The flags make eCW ask before
 * opening the Patient Hub (partiallyMerged, mergeSource, needsEhxExport) or
 * mark the patient inactive on the Hub.
 */
export const MOCK_ECW_PATIENTS = [
  // One chart for this MRN: the normal case.
  { id: "300001", externalMrn: "GM100001", lastName: "TESTLASTA", firstName: "PATA", dob: "01/02/1940", acctNo: "50001" },
  // Two charts share this MRN (a duplicate chart): must come out as "several".
  { id: "300002", externalMrn: "GM100002", lastName: "TESTLASTB", firstName: "PATB", dob: "02/03/1941", acctNo: "50002" },
  { id: "300003", externalMrn: "GM100002", lastName: "TESTLASTB", firstName: "PATB", dob: "02/03/1941", acctNo: "50003" },
  // Hyphen and space in the last name, as eCW may show them.
  { id: "300004", externalMrn: "GM100003", lastName: "TEST-LAST C", firstName: "PATC", dob: "03/04/1942", acctNo: "50004" },
  // Charts eCW asks about before opening — never to be answered by the program.
  { id: "300005", externalMrn: "GM100004", lastName: "TESTLASTD", firstName: "PATD", dob: "04/05/1943", acctNo: "50005", partiallyMerged: true },
  { id: "300006", externalMrn: "GM100005", lastName: "TESTLASTE", firstName: "PATE", dob: "05/06/1944", acctNo: "50006", needsEhxExport: true },
  { id: "300007", externalMrn: "GM100006", lastName: "TESTLASTF", firstName: "PATF", dob: "06/07/1945", acctNo: "50007", mergeSource: true },
  // Opens, but the Hub marks it inactive.
  { id: "300008", externalMrn: "GM100007", lastName: "TESTLASTG", firstName: "PATG", dob: "07/08/1946", acctNo: "50008", inactive: true },
];

/** Patient Docs folders shown in the fake (a few of the real ones, real IDs). Chart Documents = 2. */
const DOC_CATEGORIES = [
  [4, "Patient Documents"],
  [2, "Chart Documents"],
  [1, "Lab Documents"],
  [5, "Consult Notes"],
  [8, "Misc."],
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

const pageHtml = ({ appReadyDelayMs, flattenWarning }) => `<!doctype html>
<html><head><title>eCW (Mock, User)</title>
<style>.hidden{display:none} .modal{border:1px solid #888;padding:8px;margin:8px} td,th{border:1px solid #ccc;padding:2px 6px}</style>
</head><body>
<header>
  <a class="cursor icon-usersearch userbtn pull-left" type="patient" title="Action">[patient search]</a>
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
    <button type="button" id="patientSearchBtn11" title="ALT + H" onclick="launchHub()">Patient Hub</button>
    <button type="button" id="patientSearchBtn12" title="ALT + I">Patient Demographics</button>
    <table class="table table-bordered blue-fade-table"><thead><tr>${HEADERS.map((h) => `<th>${h}</th>`).join("")}</tr></thead></table>
    <table class="table table-bordered blue-fade-table" id="rule-table2"><tbody></tbody></table>
  </div>
</div>

<div class="modal fade bluetheme modal-width hidden" id="patient_hub">
  <div class="modal-header">
    <button type="button" id="patient-hubBtn1" onclick="closeHub()">×</button>
    <span class="modal-title">Patient Hub <span id="hubName" ng-bind="trimPatientDetails(PatientHubInfo.strNamewithsuffix,18)"></span></span>
  </div>
  <div class="modal-body">
    DOB: <span ng-bind="PatientHubInfo.dateOfBirth"></span>
    MRN: <strong><span ng-bind="PatientHubInfo.mrn"></span></strong>
    <div class="dropdown pull-left">
      <button type="button" id="letterDropDown" class="btn blu-ligtgry btn-sm dropdown-toggle" onclick="toggleDocMenu()"></button>
      <ul class="dropdown-menu hidden" id="hubDocMenu">
        <li class="hlight"><a id="letterDropDownLink" onclick="openPatientDocs()">Patient Doc - Web Mode</a></li>
        <li class="hlight"><a id="letterDropDownLink" onclick="fetch('/mock/plugin-mode', { method: 'POST' })">Patient Doc - Plug-in Mode</a></li>
        <li>No Favorite Tag Group(s) Configured</li>
      </ul>
    </div>
  </div>
</div>

<div class="modal hidden" id="modalPatientDocs">
  <div class="modal-header">
    <button type="button" id="savePrompt-tplBtn1" onclick="$('#modalPatientDocs').classList.add('hidden')">×</button>
    <span class="modal-title">Patient Documents - Web Mode</span>
  </div>
  <div id="docTree"></div>
  <input type="checkbox" id="addDescription" checked> <label for="addDescription">Add Description</label>
  <button type="button" id="patientdocsBtn4" onclick="importDocument()">Add Local</button>
  <input type="file" id="fileUpload" name="fileUpload" style="display:none">
  <iframe id="PatientDocsIframeView" name="PatientDocsIframeView-name"></iframe>
</div>

<div class="modal hidden" id="documentDetails">
  <span class="modal-title">Document Details</span>
  <button type="button" onclick="$('#documentDetails').classList.add('hidden')">Close</button>
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
  const row = (p, i) => \`<tr class="ng-scope" ng-repeat="patient in patientList track by patient.id" onclick="selectRow(\${i})">
      <td class="w4p"></td><td class="nopadding w4p"></td><td class="w13p nopadding"></td>
      <td class="w17p patientName"><span title="Launch Patient Hub. Last Name: \${esc(p.lastName)}" onclick="event.stopPropagation(); selectRow(\${i}); launchHub()">\${esc(p.lastName)}</span></td>
      <td class="w14p patientName"><span title="Launch Patient Hub. First Name: \${esc(p.firstName)}" onclick="event.stopPropagation(); selectRow(\${i}); launchHub()">\${esc(p.firstName)}</span></td>
      <td class="w8p"></td><td class="w10p">\${esc(p.dob)}</td><td class="w5p">U</td><td class="w12p">\${esc(p.acctNo)}</td>
      <td class="wd21pr"></td><td class="wd21pr"></td><td class="w14p"></td>
      <td class="w5p"><span class="pull-left bsquare"></span><i class="icon icdelet" title="Delete Patient" onclick="event.stopPropagation(); deletePatient()"></i></td>
    </tr>\`;
  const results = () => $("#rule-table2 tbody");
  let patientList = [];
  let selected = 0;
  const selectRow = (i) => {
    selected = i;
    results().querySelectorAll("tr").forEach((tr, j) => tr.classList.toggle("highlight", j === i));
  };
  const search = async () => {
    const res = await fetch("/mobiledoc/jsp/catalog/xml/getPatients.jsp", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SearchBy: $("#searchBy").textContent, primarySearchValue: $("#searchText").value }),
    });
    patientList = await res.json();
    results().innerHTML = patientList.map(row).join("");
    if (patientList.length) selectRow(0); // eCW selects the first result
  };
  const deletePatient = () => fetch("/api/delete-patient", { method: "POST" });

  // ---- Prompts (a bootbox-style dialog; see the assumptions at the top) ----
  const showDialog = (title, message, buttons) => {
    const box = document.createElement("div");
    box.className = "bootbox modal bluetheme";
    box.innerHTML = \`<div class="modal-dialog"><div class="modal-content">
      <div class="modal-header"><h4 class="modal-title">\${esc(title)}</h4></div>
      <div class="modal-body"><div class="bootbox-body">\${esc(message)}</div></div>
      <div class="modal-footer"></div></div></div>\`;
    for (const [label, handler, onClick] of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.dataset.bbHandler = handler;
      b.textContent = label;
      b.onclick = () => { box.remove(); onClick?.(); };
      box.querySelector(".modal-footer").append(b);
    }
    document.body.append(box);
  };
  const askBeforeOpening = (title, message, onYes) =>
    showDialog(title, message, [
      ["No", "cancel"],
      ["Yes", "confirm", () => { fetch("/mock/prompt-yes", { method: "POST" }); onYes(); }],
    ]);

  // ---- Patient Hub ----
  let hubPatient = null;
  const launchHub = () => {
    const p = patientList[selected];
    if (!p) return;
    if (p.partiallyMerged) return askBeforeOpening("Partially Merged Data", "Warning This patient has partially merged data. Are you sure you want to proceed?", () => openHub(p));
    if (p.mergeSource) return askBeforeOpening("eClinicalWorks", "This patient was merged into another chart and is inactive. Do you want to continue?", () => openHub(p));
    if (p.needsEhxExport) return askBeforeOpening("eClinicalWorks", "The patient has to be exported or linked to eEHX.Do you want to export or link this patient ?", () => fetch("/mock/ehx-export", { method: "POST" }));
    openHub(p);
  };
  const openHub = (p) => {
    hubPatient = p;
    closeLookup();
    const name = p.lastName + ", " + p.firstName;
    $("#hubName").textContent = (name.length > 18 ? name.slice(0, 18) + "..." : name) + (p.inactive ? " (Inactive)" : "") + " 80Y, U";
    $('#patient_hub [ng-bind="PatientHubInfo.dateOfBirth"]').textContent = p.dob;
    $('#patient_hub [ng-bind="PatientHubInfo.mrn"]').textContent = p.externalMrn;
    $("#patient_hub").classList.remove("hidden");
  };
  const closeHub = () => $("#patient_hub").classList.add("hidden");
  const toggleDocMenu = () => $("#hubDocMenu").classList.toggle("hidden");

  // ---- Patient Docs (Web Mode) and Add Local ----
  const CATEGORIES = ${JSON.stringify(DOC_CATEGORIES)};
  let selectedCategory = null;
  let showFlattenWarning = ${flattenWarning};
  const renderTree = async () => {
    const counts = await (await fetch("/mock/patient-docs?patientId=" + hubPatient.id)).json();
    $("#docTree").innerHTML = CATEGORIES.map(([id, name]) =>
      \`<a id="pt_\${id}" class="\${selectedCategory === id ? "selected" : ""}" onclick="selectCategory(\${id})">\${name}(\${counts[id] ?? 0})</a><br>\`).join("");
  };
  const selectCategory = (id) => { selectedCategory = id; renderTree(); };
  const openPatientDocs = async () => {
    $("#hubDocMenu").classList.add("hidden");
    selectedCategory = null;
    await renderTree();
    $("#modalPatientDocs").classList.remove("hidden");
  };
  const importDocument = () => {
    if (selectedCategory === null) return showDialog("eClinicalworks", "Please select a category.", [["OK", "ok"]]);
    const input = $("#fileUpload");
    input.onchange = () => {
      const file = input.files[0];
      if (!file || file.size === 0) { input.value = ""; return; }
      if (file.name.toLowerCase().endsWith(".pdf") && showFlattenWarning) askToFlatten(() => upload(file), () => (input.value = ""));
      else upload(file);
    };
    input.click();
  };
  const askToFlatten = (onOk, onCancel) => {
    const box = document.createElement("div");
    box.className = "modal show-popup-for-pdf-upload";
    box.innerHTML = \`<div class="modal-content">
      <div class="modal-title">PDF Flatten</div>
      <div class="prompt-message">PDFs should be <a class="flattenPDFInfo">flattened</a> before uploading them into Patient Documents else they may appear differently or be missing data when loaded into the system<br><br>
        <div class="input-append"><input type="checkbox" id="showFlattenPDFWarning"><i>Don't show this message again</i></div></div>
      <button type="button" class="btn btn-blue mt2">OK</button>
      <button type="button" class="btn btn-lgrey mt2">Cancel</button></div>\`;
    box.querySelector("#showFlattenPDFWarning").onclick = () => {
      showFlattenWarning = false;
      fetch("/mock/flatten-warning-off", { method: "POST" });
    };
    const [ok, cancel] = box.querySelectorAll("button");
    ok.onclick = () => { box.remove(); onOk(); };
    cancel.onclick = () => { box.remove(); onCancel(); };
    document.body.append(box);
  };
  const upload = async (file) => {
    const form = new FormData();
    form.append("fileUpload", file, file.name);
    form.append("PatientId", hubPatient.id);
    form.append("catid", selectedCategory);
    $("#PatientDocsIframeView").srcdoc = "Loading...";
    const { status } = await (await fetch("/mock/upload-document", { method: "POST", body: form })).json();
    $("#fileUpload").value = "";
    if (status === "success") {
      if ($("#addDescription").checked) $("#documentDetails").classList.remove("hidden");
      await renderTree();
    }
  };
  // Like real eCW: every change that leaves 2+ characters clears the results,
  // then searches by itself 500 ms later. (The Search button stays disabled.)
  let typingTimer;
  $("#searchText").addEventListener("input", () => {
    if ($("#searchText").value.length < 2) return;
    results().innerHTML = "";
    clearTimeout(typingTimer);
    typingTimer = setTimeout(search, 500);
  });
  // Like real eCW right after login (2026-10-23): the search icon is on screen
  // before it works — a click in the first moments does nothing.
  setTimeout(() => $("a.icon-usersearch").addEventListener("click", openLookup), ${appReadyDelayMs});
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

/** Parses a multipart upload (file + fields) with the web-standard Request.formData(). */
const readFormData = (req) =>
  new Request(`http://x${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: "half",
  }).formData();

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

/**
 * Starts the fake eCW on a random free port.
 * @param {{ patients?: object[], searchDelayMs?: number, appReadyDelayMs?: number, requireLogin?: boolean, confirmEmailAfterMs?: number | null, flattenWarning?: boolean, documents?: object[] }} [options]
 *   appReadyDelayMs: how long after the home screen appears its search icon starts working
 *   searchDelayMs: how long the fake takes to answer a search
 *   requireLogin: false (default) opens straight on the home screen, for the search tests
 *   confirmEmailAfterMs: "click" the email link this long after a correct password (null = only via confirmEmail())
 *   flattenWarning: true (default) shows the "PDF Flatten" warning; false = this user switched it off (choosing a file uploads at once)
 *   documents: documents already in charts, e.g. [{ patientId: "300001", catid: 2, customName: "2026-10-12 Progress Note" }]
 *   failUploads: true = eCW answers uploads with a failure and stores nothing
 */
export const startMockEcw = async ({
  patients = MOCK_ECW_PATIENTS,
  searchDelayMs = 300,
  appReadyDelayMs = 0,
  requireLogin = false,
  confirmEmailAfterMs = null,
  flattenWarning = true,
  documents = [],
  failUploads = false,
} = {}) => {
  // What the browser did — tests check these (e.g. deletes must stay 0).
  const state = {
    searches: [],
    deletes: 0,
    logins: 0,
    failedLogins: 0,
    emailsSent: 0,
    uploads: [], // { patientId, externalMrn, catid, customName, sha256 } per document received
    promptsAnsweredYes: 0, // "Yes" on a prompt before opening a patient — the program must never
    ehxExports: 0, // patients exported/linked to eEHX — a write the program must never cause
    pluginModeOpened: 0,
    flattenWarningTurnedOff: false, // the program must never tick "Don't show this message again"
  };
  const chartDocuments = documents.map((d) => ({ ...d }));
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
      else html(pageHtml({ appReadyDelayMs, flattenWarning }));
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
    } else if (url.pathname === "/mock/patient-docs") {
      const patientId = url.searchParams.get("patientId");
      const counts = {};
      for (const d of chartDocuments.filter((d) => d.patientId === patientId)) counts[d.catid] = (counts[d.catid] ?? 0) + 1;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(counts));
    } else if (url.pathname === "/mock/upload-document" && req.method === "POST") {
      const form = await readFormData(req);
      if (failUploads) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "failed" }));
        return;
      }
      const file = form.get("fileUpload");
      const bytes = Buffer.from(await file.arrayBuffer());
      const patientId = String(form.get("PatientId"));
      const doc = {
        patientId,
        externalMrn: patients.find((p) => p.id === patientId)?.externalMrn,
        catid: Number(form.get("catid")),
        customName: file.name.replace(/\.[^.]+$/, ""), // like eCW: the file's name without its extension
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
      chartDocuments.push(doc);
      state.uploads.push(doc);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "success" }));
    } else if (url.pathname === "/mock/prompt-yes" && req.method === "POST") {
      state.promptsAnsweredYes++;
      res.writeHead(200).end();
    } else if (url.pathname === "/mock/ehx-export" && req.method === "POST") {
      state.ehxExports++;
      res.writeHead(200).end();
    } else if (url.pathname === "/mock/plugin-mode" && req.method === "POST") {
      state.pluginModeOpened++;
      res.writeHead(200).end();
    } else if (url.pathname === "/mock/flatten-warning-off" && req.method === "POST") {
      state.flattenWarningTurnedOff = true;
      flattenWarning = false; // eCW remembers it for this user
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
