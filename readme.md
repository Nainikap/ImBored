# Website Archaeologist

A Chrome extension that reverse-engineers a website's architecture by
passively observing it at runtime — network traffic, response headers,
cookies, WebSocket activity, DOM structure, and JavaScript globals — and
combines those signals into a scored, evidence-backed report of the site's
likely frontend framework, CSS library, build tool, backend technology,
hosting platform, API style, auth mechanism, and third-party integrations.

Nothing is guessed from a single fingerprint. Every conclusion is a
weighted combination of multiple independent signals, and every conclusion
in the report links back to the raw evidence that produced it, so you can
verify it yourself.

The entire system runs locally in the browser. No backend, no external
API calls, no telemetry.

---

## How it works

```
 ┌──────────────────┐        ┌────────────────────┐
 │  content-script.js │      │  MAIN-world probe   │   evidence capture
 │  (isolated world)  │      │  (window globals,   │   ── DOM/runtime side
 │  DOM/attrs/CSS/    │      │   React Fiber, Vue   │
 │  scripts/cookies   │      │   instance markers)  │
 └─────────┬──────────┘      └──────────┬───────────┘
           │                            │
           └─────────────┬──────────────┘
                          ▼
              ┌────────────────────────┐
              │ background/            │   evidence capture
              │ debugger-collector.js  │   ── network side, via
              │ (chrome.debugger / CDP)│      Chrome DevTools Protocol
              └───────────┬─────────────┘
                          ▼
              ┌────────────────────────┐
              │ background/            │   orchestration + message
              │ service-worker.js      │   routing between popup,
              │                        │   content script, and storage
              └───────────┬─────────────┘
                          ▼
              ┌────────────────────────┐
              │ evidence-store.js      │   persistence (IndexedDB)
              │ (scans + evidence)     │
              └───────────┬─────────────┘
                          ▼
              ┌────────────────────────┐
              │ inference-engine.js    │   scoring: raw evidence →
              │                        │   ranked, confidence-scored
              │                        │   technology detections
              └───────────┬─────────────┘
                          ▼
              ┌────────────────────────┐
              │ report-builder.js      │   shapes detections into
              │                        │   overview / graphs / API map /
              │                        │   auth flow — plain JSON
              └───────────┬─────────────┘
                          ▼
              ┌────────────────────────┐
              │ report/report.js       │   renders everything as real
              │                        │   DOM + hand-rolled SVG
              └────────────────────────┘
```

A scan, started from the popup, runs for roughly 12 seconds. During that
window `chrome.debugger` attaches to the active tab and passively observes
Network/Page/Performance CDP events, while a content script and a
MAIN-world probe inspect the live DOM and `window` globals. Everything
collected is tagged as `{source, signal, value, timestamp}` and written to
IndexedDB the moment the scan stops — see **Why IndexedDB, not just
memory** below for why that matters.

The inference engine never treats one signal as proof. Each technology has
several independent, weighted checks; confidence is the fraction of a
technology's _own_ available checks that fired, so a technology with only
two possible signals isn't unfairly penalized against one with six.

---

## Project structure

```
website-archaeologist/
├── manifest.json                  MV3 config: permissions, background, popup, icons
├── icons/                         Extension icons (16/48/128px)
│
├── background/
│   ├── service-worker.js          Entry point — scan lifecycle, message routing,
│   │                              MAIN-world probe injection
│   └── debugger-collector.js      chrome.debugger (CDP) wrapper — network, headers,
│                                  cookies, WebSocket, performance capture
│
├── content-script.js              Isolated-world DOM inspector — meta tags, script
│                                  tags, DOM attributes, CSS class patterns, cookies
│
├── evidence-store.js              IndexedDB persistence layer — scans + evidence
│
├── inference-engine.js            Rules + scorer — evidence → ranked tech detections
│
├── report-builder.js              Evidence + inference → report JSON (overview,
│                                  dependency graph, request flow, auth flow, API map)
│
├── popup/
│   ├── popup.html                 Scan launcher UI
│   └── popup.js                   Start/stop scan, status polling, opens report
│
└── report/
    ├── report.html                Full report page shell
    └── report.js                  Fetches evidence, builds report, renders all sections
```

---

## Installation

1. Download or clone this project folder.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `website-archaeologist` folder.
5. Pin the extension for easy access (puzzle-piece icon → pin).

Requires **Chrome 111 or later** — the extension relies on
`chrome.scripting.executeScript({ world: "MAIN" })` to read page-level
JavaScript globals (React/Vue internals, `window.__NEXT_DATA__`, etc.),
which isn't available in earlier versions.

## Usage

1. Navigate to the site you want to inspect.
2. Click the extension icon → **Start Scan**.
3. Chrome will show a **"this tab is being debugged"** banner for the
   duration of the scan (~12s) — this is `chrome.debugger` attaching, and
   is unavoidable by design; nothing on the page is modified.
4. When the scan finishes, click **View Report** to open the full
   breakdown in a new tab.

You can re-scan a tab at any time; each scan is stored as its own record,
and the report always shows the most recent one for that tab.

---

## Permissions, explained

| Permission                     | Why it's needed                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `debugger`                     | Attaches Chrome DevTools Protocol to observe network/performance events without modifying the page       |
| `scripting`                    | Injects the DOM inspector (isolated world) and the globals probe (MAIN world) into the scanned tab       |
| `storage` / IndexedDB          | Persists scan evidence so it survives service worker restarts between scan completion and report viewing |
| `tabs` / `activeTab`           | Identifies which tab to scan and opens the report in a new tab                                           |
| `host_permissions: <all_urls>` | Required for `chrome.debugger` and `chrome.scripting` to operate on whatever site you choose to scan     |

No data ever leaves the browser. There is no remote server component.

---

## Design decisions worth knowing about

**Why IndexedDB, not just in-memory storage.**
MV3 service workers can be terminated by Chrome after ~30 seconds of
inactivity. A scan itself stays alive (debugger events reset the idle
timer), but the gap between "scan finished" and "user clicks View Report"
is exactly the kind of idle window that can get the worker killed —
taking any in-memory evidence with it. `evidence-store.js` persists
evidence to IndexedDB the moment a scan stops, and every read (report
page, status checks) goes through the store rather than memory.

**Why the content script waits for an explicit stop signal.**
The content script watches for late-loading scripts (lazy chunks, deferred
analytics) via a `MutationObserver`. Rather than racing two independently
tuned timeouts (one in the content script, one in the service worker) that
only work if their magic numbers happen to agree, `stopScan()` explicitly
messages the content script to stop and flush before it persists and
clears evidence — closing that race properly instead of padding around it.

**Why the dependency graph is "inferred," not "verified."**
The graph in the report represents a plausible architectural layering
(client → network → server → infrastructure) built from the highest-
confidence guess per category. The browser never sees a site's actual
source code or server configuration — this is arranging confident guesses
into a readable shape for a human to sanity-check, not asserting ground
truth. The report is explicit about this in its structure: every
conclusion is paired with the raw evidence that produced it.

**Why report rendering never uses `innerHTML`.**
Every dynamic value shown in the report (header values, cookie names,
script URLs, class names) originates from whatever site was scanned —
which may be adversarial. `report.js` builds all DOM content through
`createTextNode`/`textContent`, never string-interpolated `innerHTML`.
Given this extension holds `debugger` and `scripting` permissions, a
stored-XSS bug in its own report page would be a meaningfully worse
outcome than the same bug in an ordinary webpage.

---

## Testing / verifying it works

1. **Load errors**: check the extension's card in `chrome://extensions`
   for a red "Errors" button after loading.
2. **Service worker console**: click "service worker" on the extension's
   card to open its dedicated DevTools console — this is where scan
   orchestration and evidence-store errors actually surface. It's easy to
   miss since it's separate from any regular tab's console.
3. **Run a scan on a known site** (e.g. `nextjs.org`, `react.dev`, a
   WordPress blog) and sanity-check the report against what you already
   know about that site's stack.
4. **Check IndexedDB directly**: DevTools → Application → IndexedDB →
   `website-archaeologist` → `scans` / `evidence` — confirms the capture
   pipeline worked independent of whether the report renders correctly.
5. **Content script errors**: open DevTools on the _scanned page itself_
   (not the report page) to catch errors from `content-script.js` or the
   MAIN-world probe.

Note: after editing any file, you must click the reload icon on the
extension's card in `chrome://extensions` — Chrome does not auto-reload
extension code, and the service worker in particular can keep running
stale code until you do.

---

## Extending the inference rules

All detection logic lives in `inference-engine.js` as a single `RULES`
object: `category → technology → weighted checks`. To add a new
technology, add an entry with one or more checks, each a `{weight, label,
test}` where `test(evidence)` returns the matching evidence records (or an
empty array for no match). No other file needs to change — the scorer,
report builder, and report UI all consume `RULES` generically.

## Known limitations

- Detection quality depends entirely on what happens to load/execute
  during the ~12s scan window — sites with heavy lazy-loading or that
  require user interaction (login, scrolling) to reveal their stack may
  score lower confidence than they otherwise would.
- Database inference is intentionally narrow: databases are almost never
  visible from the browser directly, so those rules only fire when a
  client SDK talks straight to a database's HTTP API (e.g. Supabase,
  Firebase).
- The dependency graph shows the single top-confidence candidate per
  category for readability; lower-ranked candidates are still visible in
  the Tech Stack and Raw Evidence sections.
