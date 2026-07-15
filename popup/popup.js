// popup/popup.js
//
// Drives the popup UI: resolves the active tab, starts/stops a scan via
// messages to the service worker, polls status while a scan is running,
// and opens report.html when one is available.

const DOM = {
  tabUrl: document.getElementById("tab-url"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  evidenceCount: document.getElementById("evidence-count"),
  errorText: document.getElementById("error-text"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  viewReportBtn: document.getElementById("view-report-btn"),
};

/** @type {chrome.tabs.Tab|null} */
let currentTab = null;
let pollHandle = null;

function startPolling() {
  if (pollHandle) return;
  pollHandle = setInterval(refreshStatus, 600);
}

function stopPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

function applyState(status, evidenceCount, errorMessage) {
  DOM.statusDot.className =
    `status-dot ${status === "idle" ? "" : status}`.trim();
  DOM.errorText.hidden = status !== "error";
  if (status === "error")
    DOM.errorText.textContent = errorMessage || "The scan failed.";

  switch (status) {
    case "scanning":
      DOM.statusText.textContent = "Scanning…";
      DOM.evidenceCount.textContent = `${evidenceCount} signal${evidenceCount === 1 ? "" : "s"} collected so far`;
      DOM.startBtn.hidden = true;
      DOM.stopBtn.hidden = false;
      DOM.stopBtn.disabled = false;
      DOM.viewReportBtn.disabled = true;
      startPolling();
      break;

    case "done":
      DOM.statusText.textContent = "Scan complete";
      DOM.evidenceCount.textContent = `${evidenceCount} signal${evidenceCount === 1 ? "" : "s"} collected`;
      DOM.startBtn.hidden = false;
      DOM.startBtn.textContent = "Scan Again";
      DOM.startBtn.disabled = false;
      DOM.stopBtn.hidden = true;
      DOM.viewReportBtn.disabled = false;
      stopPolling();
      break;

    case "error":
      DOM.statusText.textContent = "Scan failed";
      DOM.evidenceCount.textContent = "";
      DOM.startBtn.hidden = false;
      DOM.startBtn.textContent = "Try Again";
      DOM.startBtn.disabled = false;
      DOM.stopBtn.hidden = true;
      DOM.viewReportBtn.disabled = true;
      stopPolling();
      break;

    default: // idle
      DOM.statusText.textContent = "Ready to scan";
      DOM.evidenceCount.textContent = "";
      DOM.startBtn.hidden = false;
      DOM.startBtn.textContent = "Start Scan";
      DOM.startBtn.disabled = false;
      DOM.stopBtn.hidden = true;
      DOM.viewReportBtn.disabled = true;
      stopPolling();
  }
}

async function refreshStatus() {
  if (!currentTab?.id) return;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GET_SCAN_STATUS",
      tabId: currentTab.id,
    });
    if (res?.ok) {
      applyState(res.status, res.evidenceCount, res.error);
    }
  } catch {
    // background momentarily unavailable (e.g. waking up) — next poll tick will retry
  }
}

async function handleStart() {
  if (!currentTab?.id) return;
  applyState("scanning", 0, "");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "START_SCAN",
      tabId: currentTab.id,
    });
    if (!res?.ok) {
      applyState("error", 0, res?.error);
      return;
    }
    refreshStatus();
  } catch (err) {
    applyState("error", 0, String(err?.message ?? err));
  }
}

async function handleStop() {
  if (!currentTab?.id) return;
  DOM.stopBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: "STOP_SCAN",
      tabId: currentTab.id,
    });
  } finally {
    refreshStatus();
  }
}

function handleViewReport() {
  if (!currentTab?.id) return;
  const url = chrome.runtime.getURL(
    `report/report.html?tabId=${currentTab.id}`,
  );
  chrome.tabs.create({ url });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;

  if (!currentTab?.id || !/^https?:/.test(currentTab.url ?? "")) {
    DOM.tabUrl.textContent = "No scannable page in this tab";
    DOM.startBtn.disabled = true;
    return;
  }

  DOM.tabUrl.textContent = currentTab.url;
  DOM.startBtn.addEventListener("click", handleStart);
  DOM.stopBtn.addEventListener("click", handleStop);
  DOM.viewReportBtn.addEventListener("click", handleViewReport);

  await refreshStatus();
}

init();
