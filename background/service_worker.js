// background/service-worker.js
//
// Entry point for the extension's background logic. Responsibilities:
//   1. Own the scan lifecycle state machine (idle -> scanning -> done) per tab.
//   2. Route messages between popup.js, content-script.js, and this file.
//   3. Drive debugger-collector.js (CDP capture) and, once a scan finishes,
//      hand its evidence off to evidence-store.js / inference-engine.js
//      (added in the next step — this file already calls stubs for them
//      via dynamic import so it degrades gracefully until those files exist).

import {
  attachDebugger,
  detachDebugger,
  isAttached,
  getEvidence,
  clearEvidence,
  disposeSession,
  addExternalEvidence,
} from "./debugger_collector";
const DEFAULT_SCAN_DURATION_MS = 12000;
const scans = new Map();

function getScanState(tabId) {
  return (
    scans.get(tabId) ?? {
      status: "idle",
      startedAt: 0,
      timeoutId: null,
      error: "",
    }
  );
}
function setScanState(tabId, patch) {
  const nest = { ...getScanState(tabId), ...patch };
  scans.set(tabId, next);
  return next;
}

async function startScan(tabId, durationMs = DEFAULT_SCAN_DURATION_MS) {
  const current = getScanState(tabId);
  if (current.status === "scanning") {
    return { ok: true, alreadyScanning: true };
  }
  clearEvidence(tabId);
  setScanState(tabId, { status: "scanning", startedAt: Date.now(), error: "" });

  try {
    await attachDebugger(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      file: ["content_script.js"],
    });

    const timeoutId = setTimeout(() => {
      stopScan(tabId).catch((error) => {
        console.error("[chrome-digger] auto-stop failed", error);
      });
    }, durationMs);
    setScanState(tabId, { timeoutId });
    return { ok: true };
  } catch (error) {
    setScanState(tabId, {
      status: "error",
      error: String(error?.message ?? error),
    });
    if (isAttached(tabId)) await detachDebugger(tabId);
    return { ok: false, error: String(error?.message ?? error) };
  }
}

async function stopScan(tabId) {
  const state = getScanState(tabId);
  if (state.timeoutId) clearTimeout(state.timeoutId);

  if (isAttached(tabId)) await detachDebugger(tabId);

  setScanState(tabId, { status: "done", timeoutId: null });
  return { ok: true, evidenceCount: getEvidence(tabId).length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, error: String(error?.message ?? error) }),
    );
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_SCAN": {
      const tabId = message?.tabId ?? sender.tab?.id;
      if (tabId == null) return { ok: false, error: "No tabId provided" };
      return startScan(tabId, message.durationMs);
    }
    case "STOP_SCAN": {
      const tabId = message?.tabId ?? sender.tab?.id;
      if (tabId == null) return { ok: false, error: "No tabId provided" };
      return stopScan(tabId);
    }
    case "GET_SCAN_STATUS": {
      const tabId = message.tabId;
      const state = getScanState(tabId);
      return {
        ok: true,
        status: state.status,
        startedAt: state.startedAt,
        error: state.error,
        evidenceCount: getEvidence(tabId).length,
      };
    }
    case "GET_EVIDENCE": {
      const tabId = message.tabId;
      return { ok: true, evidence: getEvidence(tabId) };
    }
    case "DOM_EVIDENCE": {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: "Missing sender tab" };
      const records = Array.isArray(message.records) ? message.records : [];
      for (const record of records) {
        addExternalEvidence(
          tabId,
          record.source ?? "dom",
          record.signal,
          record.value,
        );
      }
      return { ok: true, received: records.length };
    }
    default:
      return { ok: false, error: `Unknown message type ${message?.type}` };
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const state = getScanState(tabId);
  if (state.timeoutId) clearTimeout(state.timeoutId);
  if (isAttached(tabId)) detachDebugger(tabId).catch((err) => {});
  scans.delete(tabId);
  disposeSession(tabId);
});

function mainWorldProbe() {
  const out = {};

  try {
    // --- Framework globals -------------------------------------------------
    if (window.__NEXT_DATA__)
      out.nextData = {
        buildId: window.__NEXT_DATA__.buildId ?? null,
        page: window.__NEXT_DATA__.page ?? null,
      };
    if (window.__NUXT__) out.nuxtData = true;
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) out.reactDevtoolsHook = true;
    if (window.React && window.React.version)
      out.reactGlobalVersion = window.React.version;
    if (window.Vue && window.Vue.version)
      out.vueGlobalVersion = window.Vue.version;
    if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) out.vueDevtoolsHook = true;
    if (window.ng || typeof window.getAllAngularRootElements === "function")
      out.angularModern = true;
    if (window.angular && window.angular.version)
      out.angularJsVersion = window.angular.version.full;
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery)
      out.jqueryVersion = window.jQuery.fn.jquery;
    if (window.__APOLLO_STATE__ || window.__APOLLO_CLIENT__)
      out.apolloGraphqlState = true;
    if (window.__INITIAL_STATE__ || window.__PRELOADED_STATE__)
      out.ssrInitialStateGlobal = true;
    if (window.__REDUX_DEVTOOLS_EXTENSION__) out.reduxDevtoolsHook = true;
    if (window.Shopify)
      out.shopifyGlobal = {
        checkoutHost: window.Shopify.checkout?.host ?? null,
      };
    if (window.wp) out.wordpressGlobal = true;

    // --- Third-party integrations ------------------------------------------
    if (window.dataLayer) out.gtmDataLayer = true;
    if (typeof window.gtag === "function") out.gtagPresent = true;
    if (typeof window.ga === "function") out.gaPresent = true;
    if (window.Stripe) out.stripeGlobal = true;
    if (window.grecaptcha) out.recaptchaGlobal = true;
    if (window.Sentry) out.sentryGlobal = true;
    if (window.Intercom) out.intercomGlobal = true;
    if (window.Segment || window.analytics) out.segmentGlobal = true;

    // --- Fiber / Vue instance markers on likely root elements --------------
    const rootCandidates = ["#root", "#app", "#__next", "#__nuxt", "body"]
      .map((sel) => document.querySelector(sel))
      .filter(Boolean);

    const fiberKeyRe = /^__reactFiber\$|^__reactContainer\$|^__reactProps\$/;
    const foundFiber =
      rootCandidates.some((el) =>
        Object.keys(el).some((k) => fiberKeyRe.test(k)),
      ) || !!document.querySelector("[data-reactroot]");
    if (foundFiber) out.reactFiberMarkerFound = true;

    const foundVueInstance = rootCandidates.some(
      (el) => "__vue__" in el || "__vue_app__" in el,
    );
    if (foundVueInstance) out.vueInstanceMarkerFound = true;
  } catch (err) {
    out.probeError = String(err && err.message ? err.message : err);
  }

  return out;
}

/** Flattens the mainWorldProbe() result object into evidence records. */
function mainWorldResultToRecords(result) {
  return Object.entries(result ?? {}).map(([signal, value]) => ({
    source: "globals",
    signal,
    value,
  }));
}
