// report/report.js
//
// Entry point for report.html. Reads ?tabId= from the URL, asks the
// service worker for that tab's persisted evidence, builds the report via
// report-builder.js, and renders it.
//
// Security note: every scrap of dynamic text rendered here (header values,
// cookie names, script URLs, class names...) originates from the page that
// was scanned — which may be adversarial. All of it is inserted via
// createTextNode/textContent through the h()/svgEl() helpers below, never
// via innerHTML string interpolation. This extension holds `debugger` and
// `scripting` permissions, so a stored-XSS bug in its own report page would
// be a meaningfully worse outcome than the same bug in an ordinary webpage.

import { buildReport } from "../report_builder.js";

// ---------------------------------------------------------------------------
// Tiny safe DOM builders
// ---------------------------------------------------------------------------

/** @param {string} tag @param {Object} [attrs] @param {*} [children] */
function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** @param {string} tag @param {Object} [attrs] @param {*} [children] */
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

function applyAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
}

function appendChildren(node, children) {
  const kids = Array.isArray(children) ? children : [children];
  for (const kid of kids) {
    if (kid === null || kid === undefined) continue;
    node.appendChild(
      typeof kid === "string" || typeof kid === "number"
        ? document.createTextNode(String(kid))
        : kid,
    );
  }
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function fmtPct(confidence) {
  return `${Math.round(confidence * 100)}%`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

/** Safe preview of an arbitrary evidence value for display — stringified, truncated, still rendered as plain text. */
function previewValue(value, maxLen = 120) {
  let str;
  try {
    str = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  if (str.length > maxLen) str = str.slice(0, maxLen) + "…";
  return str;
}

const CATEGORY_LABELS = {
  "frontend-framework": "Frontend Framework",
  "css-library": "CSS Library",
  "build-tool": "Build Tool",
  "backend-technology": "Backend Technology",
  "hosting-platform": "Hosting Platform",
  "api-style": "API Style",
  "auth-mechanism": "Auth Mechanism",
  database: "Database",
  "third-party-integration": "Third-Party Integration",
};

const CATEGORY_ORDER = [
  "frontend-framework",
  "css-library",
  "build-tool",
  "backend-technology",
  "hosting-platform",
  "api-style",
  "auth-mechanism",
  "database",
  "third-party-integration",
];

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(report) {
  document.getElementById("site-url").textContent =
    report.meta.url || "(unknown URL)";
  document.getElementById("headline").textContent = report.overview.headline;

  const started = report.meta.startedAt
    ? new Date(report.meta.startedAt).toLocaleString()
    : "unknown time";
  const durationMs =
    report.meta.finishedAt && report.meta.startedAt
      ? report.meta.finishedAt - report.meta.startedAt
      : null;
  const durationStr = durationMs
    ? `${(durationMs / 1000).toFixed(1)}s scan`
    : "";

  document.getElementById("scan-meta").textContent =
    `Scan #${report.meta.scanId ?? "—"} · ${started}${durationStr ? " · " + durationStr : ""} · ${report.overview.totalEvidence} evidence records`;
}

function renderOverview(report) {
  const container = document.getElementById("overview-body");
  clear(container);

  const chips = h(
    "div",
    { class: "stat-chips" },
    Object.entries(report.overview.evidenceCounts).map(([source, count]) =>
      h("span", { class: "stat-chip" }, [
        h("strong", {}, String(count)),
        ` ${source}`,
      ]),
    ),
  );
  container.appendChild(chips);

  const picks = Object.entries(report.overview.topPicks);
  if (picks.length === 0) {
    container.appendChild(
      h(
        "p",
        { class: "empty-state" },
        "No technologies were detected with enough confidence to report.",
      ),
    );
    return;
  }

  container.appendChild(
    h(
      "div",
      { class: "toppick-grid" },
      picks.map(([category, pick]) =>
        h("div", { class: "toppick-card" }, [
          h("div", { class: "cat" }, CATEGORY_LABELS[category] ?? category),
          h("div", { class: "name" }, pick.name),
          h("div", { class: "conf" }, fmtPct(pick.confidence)),
        ]),
      ),
    ),
  );
}

function renderTechStack(report) {
  const container = document.getElementById("tech-stack-body");
  clear(container);

  const categories = CATEGORY_ORDER.filter(
    (c) => (report.techStack[c] || []).length > 0,
  );
  if (categories.length === 0) {
    container.appendChild(
      h(
        "p",
        { class: "empty-state" },
        "No technologies were detected with enough confidence to report.",
      ),
    );
    return;
  }

  for (const category of categories) {
    const detections = report.techStack[category];
    const card = h("div", { class: "tech-card" }, [
      h("h3", {}, CATEGORY_LABELS[category] ?? category),
    ]);

    for (const det of detections) {
      const bar = h("div", { class: "confidence-bar" }, [
        h("div", {
          class: "confidence-fill",
          style: `width:${Math.round(det.confidence * 100)}%`,
        }),
      ]);

      const evidenceItems = det.matchedChecks.map((check) =>
        h("li", {}, [
          `${check.label} `,
          h("span", { class: "weight" }, `(+${check.weight})`),
          h(
            "span",
            { class: "raw" },
            check.evidence
              .slice(0, 2)
              .map((e) => previewValue(e.value))
              .join("  ·  "),
          ),
        ]),
      );

      const details = h("details", {}, [
        h(
          "summary",
          {},
          `${det.matchedChecks.length} supporting signal${det.matchedChecks.length === 1 ? "" : "s"}`,
        ),
        h("ul", { class: "evidence-list" }, evidenceItems),
      ]);

      const row = h("div", { class: "tech-row" }, [
        h("div", { class: "tech-row-main" }, [
          h("span", { class: "tech-name" }, det.name),
          bar,
          h("span", { class: "confidence-pct" }, fmtPct(det.confidence)),
        ]),
        details,
      ]);
      card.appendChild(row);
    }

    container.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Dependency graph (hand-rolled SVG, no charting library)
// ---------------------------------------------------------------------------

const GRAPH_LAYER_BY_CATEGORY = {
  root: 0,
  "frontend-framework": 1,
  "css-library": 1,
  "build-tool": 1,
  "third-party-integration": 1.6,
  "api-style": 2,
  "auth-mechanism": 2,
  "backend-technology": 3,
  database: 3,
  "hosting-platform": 4,
};

function renderDependencyGraph(report) {
  const container = document.getElementById("dependency-graph-body");
  clear(container);

  const { nodes, edges } = report.graphs.dependencyGraph;
  if (nodes.length <= 1) {
    container.appendChild(
      h(
        "p",
        { class: "empty-state" },
        "Not enough evidence to draw a dependency graph yet.",
      ),
    );
    return;
  }

  const NODE_W = 150;
  const NODE_H = 44;
  const LAYER_GAP = 110;
  const COL_GAP = 24;

  // Group nodes by their layer, then lay each layer out in a centered row.
  const byLayer = new Map();
  for (const node of nodes) {
    const layer =
      node.type === "root" ? 0 : (GRAPH_LAYER_BY_CATEGORY[node.category] ?? 5);
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(node);
  }

  const layers = Array.from(byLayer.keys()).sort((a, b) => a - b);
  const maxNodesInLayer = Math.max(...layers.map((l) => byLayer.get(l).length));
  const width = Math.max(560, maxNodesInLayer * (NODE_W + COL_GAP));
  const height = layers.length * LAYER_GAP + NODE_H + 20;

  const positions = new Map(); // nodeId -> {x, y}
  for (const layer of layers) {
    const rowNodes = byLayer.get(layer);
    const rowWidth = rowNodes.length * NODE_W + (rowNodes.length - 1) * COL_GAP;
    const startX = (width - rowWidth) / 2;
    rowNodes.forEach((node, i) => {
      positions.set(node.id, {
        x: startX + i * (NODE_W + COL_GAP),
        y: layer * LAYER_GAP + 10,
      });
    });
  }

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height,
    role: "img",
    "aria-label": "Inferred dependency graph",
  });

  // Edges first, so nodes render on top.
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    const midY = (y1 + y2) / 2;
    const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    svg.appendChild(
      svgEl("path", {
        d: path,
        fill: "none",
        stroke:
          edge.style === "satellite" ? "var(--accent-rust)" : "var(--border)",
        "stroke-width": edge.style === "satellite" ? 1.2 : 1.6,
        "stroke-dasharray": edge.style === "satellite" ? "4,3" : undefined,
      }),
    );
  }

  for (const node of nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const isRoot = node.type === "root";
    const strokeColor = isRoot
      ? "none"
      : node.category === "third-party-integration"
        ? "var(--accent-rust)"
        : "var(--accent-verdigris)";
    const fillColor = isRoot ? "var(--accent-brass)" : "var(--bg-panel-raised)";
    const textColor = isRoot ? "var(--bg)" : "var(--text-primary)";

    const group = svgEl("g", {});
    group.appendChild(
      svgEl("rect", {
        x: pos.x,
        y: pos.y,
        width: NODE_W,
        height: NODE_H,
        rx: 6,
        fill: fillColor,
        stroke: strokeColor,
        "stroke-width": 1.4,
      }),
    );

    const label =
      node.label.length > 20 ? node.label.slice(0, 19) + "…" : node.label;
    group.appendChild(
      svgEl(
        "text",
        {
          x: pos.x + NODE_W / 2,
          y: pos.y + NODE_H / 2 + (node.confidence !== undefined ? -3 : 4),
          "text-anchor": "middle",
          "font-size": 12,
          fill: textColor,
        },
        label,
      ),
    );
    if (node.confidence !== undefined) {
      group.appendChild(
        svgEl(
          "text",
          {
            x: pos.x + NODE_W / 2,
            y: pos.y + NODE_H / 2 + 13,
            "text-anchor": "middle",
            "font-size": 10,
            fill: "var(--accent-brass)",
          },
          fmtPct(node.confidence),
        ),
      );
    }
    svg.appendChild(group);
  }

  container.appendChild(h("div", { class: "graph-wrap" }, svg));
}

// ---------------------------------------------------------------------------

function renderRequestFlow(report) {
  const container = document.getElementById("request-flow-body");
  clear(container);

  const { timeline } = report.graphs.requestFlow;
  if (timeline.length === 0) {
    container.appendChild(
      h(
        "p",
        { class: "empty-state" },
        "No network requests were observed during the scan.",
      ),
    );
    return;
  }

  const maxCount = Math.max(...timeline.map((t) => t.requestCount));

  for (const entry of timeline) {
    const pct = Math.max(4, Math.round((entry.requestCount / maxCount) * 100));
    const types = Object.entries(entry.resourceTypeBreakdown)
      .map(([type, count]) => `${type} ×${count}`)
      .join(", ");

    container.appendChild(
      h("div", { class: "flow-row" }, [
        h("div", { class: "flow-host" }, [
          entry.host,
          h(
            "span",
            { class: "tag" },
            entry.sameOrigin ? "same-origin" : "third-party",
          ),
        ]),
        h("div", { class: "flow-bar-track" }, [
          h("div", {
            class: `flow-bar-fill ${entry.sameOrigin ? "same-origin" : "third-party"}`,
            style: `width:${pct}%`,
          }),
        ]),
        h(
          "div",
          { class: "flow-count", title: types },
          String(entry.requestCount),
        ),
      ]),
    );
  }
}

function renderAuthFlow(report) {
  const container = document.getElementById("auth-flow-body");
  clear(container);

  const { steps, detected } = report.graphs.authFlow;
  if (!detected) {
    container.appendChild(
      h(
        "p",
        { class: "empty-state" },
        "No authentication-related signals were observed during this scan.",
      ),
    );
    return;
  }

  for (const step of steps) {
    container.appendChild(
      h("div", { class: "auth-step" }, [
        h("div", { class: "mechanism" }, step.mechanism),
        h(
          "div",
          { class: "meta" },
          `${fmtPct(step.confidence)} confidence · first observed ${fmtTime(step.timestamp)}`,
        ),
        h(
          "ul",
          {},
          step.supportingSignals.map((s) => h("li", {}, s)),
        ),
      ]),
    );
  }
}

function renderApiMap(report) {
  const container = document.getElementById("api-map-body");
  clear(container);

  const { rest, graphql, websockets } = report.graphs.apiMap;

  function column(title, items, renderItem) {
    const col = h("div", { class: "api-column" }, [h("h3", {}, title)]);
    if (items.length === 0) {
      col.appendChild(h("p", { class: "empty-state" }, "None observed."));
    } else {
      for (const item of items) col.appendChild(renderItem(item));
    }
    return col;
  }

  const grid = h("div", { class: "api-map-grid" }, [
    column(`REST (${rest.length})`, rest, (e) =>
      h("div", { class: "api-endpoint" }, [
        h("span", { class: "method" }, e.method),
        `${e.host}${e.path} `,
        h("span", { class: "count" }, `×${e.count}`),
      ]),
    ),
    column(`GraphQL (${graphql.length})`, graphql, (e) =>
      h("div", { class: "api-endpoint" }, [
        h("span", { class: "method" }, e.method),
        `${e.host}${e.path} `,
        h("span", { class: "count" }, `×${e.count}`),
      ]),
    ),
    column(`WebSocket (${websockets.length})`, websockets, (w) =>
      h("div", { class: "api-endpoint" }, w.url),
    ),
  ]);

  container.appendChild(grid);
}

function renderRawEvidence(report, evidence) {
  const container = document.getElementById("raw-evidence-body");
  clear(container);

  const bySource = new Map();
  for (const e of evidence) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }

  for (const [source, records] of Array.from(bySource.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const group = h("details", { class: "evidence-group" }, [
      h("summary", {}, [
        source,
        h("span", { class: "count" }, `${records.length} records`),
      ]),
    ]);
    const table = h("div", { class: "evidence-table" });
    for (const rec of records) {
      table.appendChild(
        h(
          "div",
          {
            class: "evidence-table-row",
            "data-search":
              `${rec.source} ${rec.signal} ${previewValue(rec.value, 500)}`.toLowerCase(),
          },
          [
            h("span", { class: "signal" }, rec.signal),
            h(
              "span",
              { class: "value", title: previewValue(rec.value, 2000) },
              previewValue(rec.value),
            ),
            h("span", { class: "time" }, fmtTime(rec.timestamp)),
          ],
        ),
      );
    }
    group.appendChild(table);
    container.appendChild(group);
  }

  const filterInput = document.getElementById("evidence-filter");
  filterInput.addEventListener("input", () => {
    const query = filterInput.value.trim().toLowerCase();
    container.querySelectorAll(".evidence-table-row").forEach((row) => {
      const matches = !query || row.getAttribute("data-search").includes(query);
      row.classList.toggle("hidden-by-filter", !matches);
    });
  });
}

// ---------------------------------------------------------------------------
// Scroll-spy for the core-sample nav
// ---------------------------------------------------------------------------

function setupScrollSpy() {
  const bands = Array.from(document.querySelectorAll(".core-band"));
  const sections = bands
    .map((b) => document.getElementById(b.dataset.target))
    .filter(Boolean);
  if (sections.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const band = bands.find((b) => b.dataset.target === entry.target.id);
          if (band) {
            bands.forEach((b) => b.classList.remove("active"));
            band.classList.add("active");
          }
        }
      }
    },
    { rootMargin: "-20% 0px -70% 0px" },
  );

  for (const section of sections) observer.observe(section);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function showFatalError(message) {
  document.getElementById("core-nav").hidden = true;
  document.getElementById("report-root").hidden = true;
  const fatal = document.getElementById("fatal-error");
  fatal.hidden = false;
  document.getElementById("fatal-error-message").textContent = message;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get("tabId"));
  console.log("href", location.href);
  console.log("search", location.search);
  console.log("params tabid", params.get("tabId"));
  console.log("tabid", tabId);

  if (!tabId) {
    console.log("i was here");
    showFatalError(
      "No tab was specified. Open this report from the extension popup after running a scan.",
    );
    return;
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "GET_EVIDENCE",
      tabId,
    });
    console.log("response", response);
  } catch (err) {
    showFatalError(
      `Could not reach the extension background service: ${err?.message ?? err}`,
    );
    return;
  }

  if (!response?.ok) {
    showFatalError(
      response?.error ||
        "No scan data was found for this tab. Run a scan from the popup first.",
    );
    return;
  }

  const scanMeta = {
    scanId: response.scanId,
    tabId,
    url: response.scan?.url ?? "",
    startedAt: response.scan?.startedAt ?? null,
    finishedAt: response.scan?.finishedAt ?? null,
  };

  const report = buildReport({ scanMeta, evidence: response.evidence });

  document.getElementById("report-root").hidden = false;
  renderHeader(report);
  renderOverview(report);
  renderTechStack(report);
  renderDependencyGraph(report);
  renderRequestFlow(report);
  renderAuthFlow(report);
  renderApiMap(report);
  renderRawEvidence(report, response.evidence);
  setupScrollSpy();
}

main();
