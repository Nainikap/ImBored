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
