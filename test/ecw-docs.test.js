import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { DateTime } from "luxon";
import { startMockEcw } from "./mock-ecw.js";
import { findByExternalMrn } from "../src/ecw/search.js";
import {
  NeedsPersonError,
  checkHubIdentity,
  openChartDocuments,
  openPatientHub,
} from "../src/ecw/docs.js";

describe(
  "docs.js: open the chart and get to Chart Documents",
  { timeout: 120_000 },
  () => {
    let browser, mock, page;
    before(async () => (browser = await chromium.launch()));
    after(async () => browser?.close());
    afterEach(async () => {
      await page?.close();
      await mock?.close();
    });

    /** A fresh fake eCW with this External MRN already searched, like the program does it. */
    const searched = async (mrn, options = {}) => {
      mock = await startMockEcw(options);
      page = await browser.newPage();
      await page.goto(mock.url);
      await findByExternalMrn(page, mrn);
    };

    const testlasta = {
      externalMrn: "GM100001",
      dateOfBirth: DateTime.fromISO("1940-01-02"),
    };

    it("opens the right chart, passes the identity check, and counts Chart Documents", async () => {
      await searched("GM100001", {
        documents: [
          { patientId: "300001", catid: 2, customName: "older note" },
        ],
      });
      const hub = await openPatientHub(page);
      await checkHubIdentity(hub, testlasta);
      assert.equal(await openChartDocuments(page, hub), 1);
    });

    for (const [mrn, what] of [
      ["GM100004", "a partially merged chart"],
      ["GM100005", "a chart eCW wants exported to eEHX"],
      ["GM100006", "a merged (inactive) chart"],
    ]) {
      it(`stops at the prompt for ${what}, and never answers it`, async () => {
        await searched(mrn);
        await assert.rejects(() => openPatientHub(page), NeedsPersonError);
        assert.equal(await page.locator("#patient_hub").isVisible(), false);
        assert.equal(mock.state.promptsAnsweredYes, 0);
        assert.equal(mock.state.ehxExports, 0);
      });
    }

    it("rejects a Hub showing a different DOB or External MRN than expected", async () => {
      await searched("GM100001");
      const hub = await openPatientHub(page);
      await assert.rejects(
        () =>
          checkHubIdentity(hub, {
            ...testlasta,
            dateOfBirth: DateTime.fromISO("1940-01-03"),
          }),
        (e) => e instanceof NeedsPersonError && /DOB/.test(e.message),
      );
      await assert.rejects(
        () => checkHubIdentity(hub, { ...testlasta, externalMrn: "GM999999" }),
        (e) => e instanceof NeedsPersonError && /External MRN/.test(e.message),
      );
    });

    it("rejects a chart marked inactive", async () => {
      await searched("GM100007");
      const hub = await openPatientHub(page);
      await assert.rejects(
        () =>
          checkHubIdentity(hub, {
            externalMrn: "GM100007",
            dateOfBirth: DateTime.fromISO("1946-07-08"),
          }),
        /inactive/,
      );
    });

    it("refuses to open anything when the search found more than one chart", async () => {
      await searched("GM100002"); // two charts share this MRN
      await assert.rejects(() => openPatientHub(page), /exactly 1 result row/);
      assert.equal(await page.locator("#patient_hub").isVisible(), false);
    });

    it("changes nothing in eCW: no uploads, deletes, Plug-in Mode or eEHX exports", async () => {
      await searched("GM100001");
      await openChartDocuments(page, await openPatientHub(page));
      assert.deepEqual(mock.state.uploads, []);
      assert.equal(mock.state.deletes, 0);
      assert.equal(mock.state.pluginModeOpened, 0);
      assert.equal(mock.state.ehxExports, 0);
    });
  },
);
