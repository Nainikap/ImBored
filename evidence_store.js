// evidence-store.js
//
// Persistence layer, built on IndexedDB. This is the single source of
// truth once a scan finishes — background/service-worker.js writes to it,
// and report/report.js reads from it. Two object stores:
//
//   scans     — one row per scan: { id, tabId, url, status, startedAt, finishedAt, evidenceCount }
//   evidence  — one row per signal: { id, scanId, source, signal, value, timestamp }
//
// Why persist at all instead of just keeping evidence in memory? MV3
// service workers can be terminated by Chrome after ~30s of inactivity.
// A scan itself stays alive (debugger events reset the idle timer), but the
// gap between "scan finished" and "user opens the report" is exactly the
// kind of idle window that can get the worker killed — taking any in-memory
// Map with it. IndexedDB survives that.

const DB_NAME = "chrome-digger";
const DB_VERSION = 1;
const SCANS_STORE = "scans";
const EVIDENCE_STORE = "evidence";

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SCANS_STORE)) {
        const scans = db.createObjectStore(SCANS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        scans.createIndex("byTabId", "tabId", { unique: false });
        scans.createIndex("byStartedAt", "startedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(EVIDENCE_STORE)) {
        const evidence = db.createObjectStore(EVIDENCE_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        evidence.createIndex("byScanId", "scanId", { unique: false });
        evidence.createIndex("bySource", "source", { unique: false });
        evidence.createIndex("bySignal", "signal", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function createScan(tabId, url) {
  const db = openDatabase();
  const tx = db.transaction(SCANS_STORE, "readwrite");
  const store = tx.objectStore(SCANS_STORE);

  const scan = {
    tabId,
    url: url ?? "",
    status: "scanning",
    startedAt: Date.now(),
    finishedAt: null,
    evidenceCount: 0,
  };

  const id = await promisifyRequest(store.add(scan));
  await promisifyTransaction(tx);
  return id;
}

export async function updateScan(scanId, patch) {
  const db = await openDatabase();
  const tx = db.transaction(SCANS_STORE, "readwrite");
  const store = tx.objectStore(SCANS_STORE);

  const existing = await promisifyRequest(store.get(scanId));
  if (!existing) {
    await promisifyTransaction(tx);
    return;
  }

  store.put({ ...existing, ...patch });
  await promisifyTransaction(tx);
}

export async function getLatestScanForTab(tabId) {
  const db = await openDatabase();
  const tx = db.transaction(SCANS_STORE, "readonly");
  const index = tx.objectStore(SCANS_STORE).index("byTabId");

  const matches = await promisifyRequest(index.getAll(IDBKeyRange.only(tabId)));
  await promisifyTransaction(tx);

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.startedAt > a.startedAt);
  return matches[0];
}

export async function listScans(limit = 25) {
  const db = await openDatabase();
  const tx = db.transaction(SCANS_STORE, "readonly");
  const store = tx.objectStore(SCANS_STORE);

  const all = await promisifyRequest(store.getAll());
  await promisifyTransaction(tx);

  return all.sort((a, b) => b.startedAt > a.startedAt).slice(0, limit);
}

export async function deleteScan(scanId) {
  const db = await openDatabase();
  const tx = db.transaction([SCANS_STORE, EVIDENCE_STORE], "readwrite");

  tx.objectStore(SCANS_STORE).delete(scanId);

  const evidenceIndex = tx.objectStore(EVIDENCE_STORE).index("byScanId");
  const cursorRequest = evidenceIndex.openCursor(IDBKeyRange.only(scanId));
  await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });

  await promisifyTransaction(tx);
}

export async function addEvidenceBatch(scanId, records) {
  if (!records || records.length === 0) return;

  const db = await openDatabase();
  const tx = db.transaction(EVIDENCE_STORE, "readwrite");
  const store = tx.objectStore(EVIDENCE_STORE);

  for (const record of records) {
    store.add({
      scanId,
      source: record.source,
      signal: record.signal,
      value: record.value,
      timestamp: record.timestamp ?? Date.now(),
    });
  }
  await promisifyTransaction(tx);
}

export async function getEvidenceByScanId(scanId) {
  const db = await openDatabase();
  const tx = db.transaction(EVIDENCE_STORE, "readonly");
  const store = tx.objectStore(EVIDENCE_STORE).index("byScanId");

  const result = await promisifyRequest(index.getAll(IDBKeyRange.only(scanId)));
  await promisifyTransaction(tx);
  return result;
}

export async function getEvidenceBySource(scanId, source) {
  const all = await getEvidenceByScanId(scanId);
  return all.filter((e) => e.source === source);
}

export async function finalizeScanWithEvidence(scanId, records) {
  await addEvidenceBatch(scanId, records);
  await updateScan(scanId, {
    status: "done",
    finishedAt: Date.now(),
    evidenceCount: records.length,
  });
}

export async function clearAll() {
  const db = openDatabase();
  const tx = db.transaction([SCANS_STORE, EVIDENCE_STORE], "readwrite");
  tx.objectStore(SCANS_STORE).clear();
  tx.objectStore(EVIDENCE_STORE).clear();
  await promisifyTransaction(tx);
}
