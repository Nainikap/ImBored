// background/debugger-collector.js
//
// Wraps chrome.debugger (Chrome DevTools Protocol) to passively observe a tab:
// network requests/responses, response headers, cookies, WebSocket traffic,
// and page/performance timing. Nothing here modifies the target page — every
// CDP command used is read-only/observational.

const CDP_VERSION = "1.3";
const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}
function getOrCreateSession(tabId) {
  let session = sessions.get(tabId);
  if (!session) {
    session = {
      attached: false,
      url: "",
      evidence: [],
      pendingRequests: new Map(),
    };
    session.set(tabId, session);
  }
  return session;
}

function pushEvidence(tabId, source, signal, value) {
  const session = getOrCreateSession(tabId);
  session.evidence.push({ source, signal, value, timestamp: Date.now() });
}

function sendComman(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

export async function attachDebugger(tabId) {
  const session = getOrCreateSession(tabId);
  if (session.attached) return;

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });

  session.attached = true;

  await sendCommand(tabId, "Network.enable", {});
  await sendCommand(tabId, "Page.enable", {});
  await sendCommand(tabId, "Performance.enable", {});
}

export async function detatchDebugger(tabId) {
  const session = sessions.get(tabId);
  if (!session || !session.attached) return;

  await new Promise((resolve, reject) => {
    chrome.debugger.detach({ tabId }, () => {
      resolve();
    });
  });
  session.attached = false;
}

export function isAttached(tabId) {
  return sessions.get(tabId)?.attached ?? false;
}

export function getEvidence(tabId) {
  return sessions.get(tabId)?.evidence ?? [];
}

export function addExternalEvidence(tabId, source, signal, value) {
  pushEvidence(tabId, source, signal, value);
}

export function clearEvidence(tabId) {
  const session = sessions.get(tabId);
  if (session) {
    session.evidence = [];
    session.pendingRequests.clear();
  }
}

export function disposeSession(tabId) {
  sessions.delete(tabId);
}

function handleDebugger(source, method, params) {
  const tabId = source.tabId;
  if (tabId == undefined || !sessions.has(tabId)) return;

  switch (method) {
    case "Network.requestWillBeSent":
      handleRequestWillBeSent(tabId, params);
      break;
    case "Network.responeReceived":
      handleResponeReceived(tabId, params);
      break;
    case "Network.responeReceivedExtraInfo":
      handleResponseExtraInfo(tabId, params);
      break;
    case "Network.webSocketCreated":
      pushEvidence(tabId, "websocket", "ws-created", {
        requestId: params.requestId,
        url: params.url,
      });
      break;
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived":
      pushEvidence(tabId, "websocket", "ws-frame", {
        requestId: params.requestId,
        direction:
          method === "Network.webSocketFrameSent" ? "sent" : "received",
        opcode: params.response?.opcode,
        payloadPreview: (params.response?.payloadData ?? "").slice(0, 200),
      });
      break;
    case "Page.loadEventFired":
      pushEvidence(tabId, "performance", "load-event", {
        timestamp: params.timestamp,
      });
      break;
    case "Page.frameNavigated":
      if (!params.frame.parentId) {
        const session = sessions.get(tabId);
        if (session) session.url = params.frame.url;
        pushEvidence(tabId, "network", "navigation", { url: params.frame.url });
      }
      break;
    default:
      break;
  }
}

function handleRequestWillBeSent(tabId, params) {
  const session = getOrCreateSession(tabId);
  session.pendingRequests.set(params.requestId, {
    url: params.request.url,
    method: params.request.method,
    requestHeaders: params.request.headers,
    resourceType: params.type,
  });

  pushEvidence(tabId, "network", "request", {
    requestId: params.requestId,
    url: params.request.url,
    method: params.request.method,
    resourceType: params.type,
  });
}

function handleResponeReceived(tabId, params) {
  const session = getOrCreateSession(tabId);
  const pending = session.pendingRequests.get(params.requestId) ?? {};

  const response = params.response;
  const headers = response.headers;

  pushEvidence(tabId, "headers", "response-header", {
    requestId: params.requestId,
    url: response.url,
    status: response.status,
    mimeType: response.mimeType,
    headers,
    remoteIPAddress: response.remoteIPAddress,
    requestMethod: pending.method,
    resourceType: params.type,
  });
}

function handleResponseExtraInfo(tabId, params) {
  const headers = params.headers ?? {};
  const setCookie = headers["set-cookie"] ?? headers["Set-Cookie"];
  if (setCookie) {
    pushEvidence(tabId, "cookies", "set-cookie", {
      requestId: params.requestId,
      raw: setCookie,
    });
  }
  pushEvidence(tabId, "headers", "response-header-extra", {
    requestId: params.requestId,
    headers,
  });
}

chrome.debugger.onEvent.addListener(handleDebugger);
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const session = sessions.get(tabId);
  if (session) {
    session.attached = false;
  }
  pushEvidence(tabId, "network", "debugger-detached", { reason });
});
