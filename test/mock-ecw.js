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

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

/**
 * Starts the fake eCW on a random free port.
 * @param {{ patients?: object[], searchDelayMs?: number }} [options]
 *   searchDelayMs: how long the fake takes to answer a search
 */
export const startMockEcw = async ({
  patients = MOCK_ECW_PATIENTS,
  searchDelayMs = 300,
} = {}) => {
  // What the browser did — tests check these (e.g. deletes must stay 0).
  const state = { searches: [], deletes: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(pageHtml());
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
    url: `http://127.0.0.1:${server.address().port}/`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
