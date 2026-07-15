// Consumes raw evidence + inference-engine.js output and produces the data
// structures report.js renders: an overview/headline, a dependency graph,
// a request-flow timeline, a best-effort auth-flow sequence, and an API
// map. Everything here is plain JSON — no SVG/DOM work happens in this
// file, that's report.js's job.

import { runInference, buildTechStackSummary } from "./inference-engine.js";

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/** Replaces numeric IDs and long hex/hash-looking path segments with placeholders, so /api/users/123 and /api/users/456 collapse into one endpoint. */
function normalizeEndpointPath(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname
      .split("/")
      .map((seg) =>
        /^\d+$/.test(seg) ? ":id" : /^[0-9a-f]{8,}$/i.test(seg) ? ":hash" : seg,
      );
    return { host: u.hostname, path: segments.join("/") || "/" };
  } catch {
    return { host: "unknown", path: url };
  }
}

function buildOverview(evidence, inferenceResults, scanMeta) {
  const evidenceCounts = {};
  for (const e of evidence) {
    evidenceCounts[e.source] = (evidenceCounts[e.source] || 0) + 1;
  }

  const topPicks = {};
  for (const [category, results] of Object.entries(inferenceResults)) {
    if (results[0]) {
      topPicks[category] = {
        id: results[0].id,
        name: results[0].name,
        confidence: results[0].confidence,
      };
    }
  }

  const headlineParts = [];
  if (topPicks["frontend-framework"])
    headlineParts.push(topPicks["frontend-framework"].name);
  if (topPicks["css-library"])
    headlineParts.push(`styled with ${topPicks["css-library"].name}`);
  if (topPicks["hosting-platform"])
    headlineParts.push(`hosted on ${topPicks["hosting-platform"].name}`);
  if (topPicks["api-style"])
    headlineParts.push(`a ${topPicks["api-style"].name} API`);

  const integrationCount = (inferenceResults["third-party-integration"] || [])
    .length;
  const integrationClause =
    integrationCount > 0
      ? `, with ${integrationCount} third-party integration${integrationCount > 1 ? "s" : ""} detected`
      : "";

  const headline =
    headlineParts.length > 0
      ? `${headlineParts.join(", ")}${integrationClause}.`
      : "Not enough evidence was collected to confidently identify this site's architecture. Try scanning again, or scanning while interacting with the page (logging in, navigating) to surface more signals.";

  return {
    scanMeta,
    evidenceCounts,
    totalEvidence: evidence.length,
    topPicks,
    headline,
  };
}

const DEPENDENCY_LAYERS = [
  {
    layer: "client",
    categories: ["frontend-framework", "css-library", "build-tool"],
  },
  { layer: "network", categories: ["api-style", "auth-mechanism"] },
  { layer: "server", categories: ["backend-technology", "database"] },
  { layer: "infrastructure", categories: ["hosting-platform"] },
];

function buildDependencyGraph(inferenceResults) {
  const nodes = [];
  const edges = [];
  const nodeIdsByLayer = {
    client: [],
    network: [],
    server: [],
    infrastructure: [],
  };

  const rootId = "website";
  nodes.push({ id: rootId, label: "This website", type: "root" });

  for (const { layer, categories } of DEPENDENCY_LAYERS) {
    for (const category of categories) {
      const top = (inferenceResults[category] || [])[0];
      if (!top) continue;
      const nodeId = `${category}:${top.id}`;
      nodes.push({
        id: nodeId,
        label: top.name,
        category,
        confidence: top.confidence,
      });
      nodeIdsByLayer[layer].push(nodeId);
    }
  }

  const populatedLayers = DEPENDENCY_LAYERS.map((l) => l.layer).filter(
    (l) => nodeIdsByLayer[l].length > 0,
  );

  if (populatedLayers.length > 0) {
    for (const nodeId of nodeIdsByLayer[populatedLayers[0]]) {
      edges.push({ from: rootId, to: nodeId });
    }
  }
  for (let i = 0; i < populatedLayers.length - 1; i++) {
    for (const from of nodeIdsByLayer[populatedLayers[i]]) {
      for (const to of nodeIdsByLayer[populatedLayers[i + 1]]) {
        edges.push({ from, to });
      }
    }
  }

  // Third-party integrations hang off the frontend framework node (or the
  // root, if none was detected) as satellites — most integrations are
  // client-loaded scripts, not part of the request/response chain.
  const clientAnchor = nodeIdsByLayer.client[0] ?? rootId;
  for (const integration of inferenceResults["third-party-integration"] || []) {
    const nodeId = `third-party-integration:${integration.id}`;
    nodes.push({
      id: nodeId,
      label: integration.name,
      category: "third-party-integration",
      confidence: integration.confidence,
    });
    edges.push({ from: clientAnchor, to: nodeId, style: "satellite" });
  }

  return { nodes, edges };
}

function buildRequestFlowDiagram(evidence) {
  const navRecords = evidence.filter((e) => e.signal === "navigation");
  const requestRecords = evidence.filter((e) => e.signal === "request");

  const primaryHost =
    navRecords.length > 0
      ? getHostname(navRecords[0].value.url)
      : requestRecords.length > 0
        ? getHostname(requestRecords[0].value.url)
        : "unknown";

  const byHost = new Map();
  for (const rec of requestRecords) {
    const host = getHostname(rec.value.url);
    if (!byHost.has(host)) {
      byHost.set(host, {
        host,
        count: 0,
        resourceTypes: {},
        firstSeen: rec.timestamp ?? Date.now(),
        sameOrigin: host === primaryHost,
      });
    }
    const entry = byHost.get(host);
    entry.count += 1;
    const type = rec.value.resourceType ?? "Other";
    entry.resourceTypes[type] = (entry.resourceTypes[type] || 0) + 1;
    if (rec.timestamp && rec.timestamp < entry.firstSeen)
      entry.firstSeen = rec.timestamp;
  }

  const timeline = Array.from(byHost.values())
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map((h) => ({
      host: h.host,
      sameOrigin: h.sameOrigin,
      requestCount: h.count,
      resourceTypeBreakdown: h.resourceTypes,
    }));

  return { primaryHost, timeline };
}

function buildAuthFlowDiagram(inferenceResults) {
  const detections = inferenceResults["auth-mechanism"] || [];

  const steps = detections.map((detection) => {
    let earliest = Infinity;
    for (const check of detection.matchedChecks) {
      for (const ev of check.evidence) {
        if (ev.timestamp && ev.timestamp < earliest) earliest = ev.timestamp;
      }
    }
    return {
      mechanism: detection.name,
      confidence: detection.confidence,
      timestamp: earliest === Infinity ? null : earliest,
      supportingSignals: detection.matchedChecks.map((c) => c.label),
    };
  });

  steps.sort((a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity));

  return { steps, detected: steps.length > 0 };
}

function buildApiMap(evidence) {
  const requestRecords = evidence.filter((e) => e.signal === "request");
  const wsRecords = evidence.filter((e) => e.signal === "ws-created");

  const endpointMap = new Map();
  for (const rec of requestRecords) {
    const isApiLikeType =
      rec.value.resourceType === "XHR" || rec.value.resourceType === "Fetch";
    if (!isApiLikeType) continue;

    const { host, path } = normalizeEndpointPath(rec.value.url);
    const isGraphQL = /graphql/i.test(path);
    const key = `${rec.value.method} ${host}${path}`;

    if (!endpointMap.has(key)) {
      endpointMap.set(key, {
        method: rec.value.method,
        host,
        path,
        count: 0,
        style: isGraphQL ? "GraphQL" : "REST",
      });
    }
    endpointMap.get(key).count += 1;
  }

  const endpoints = Array.from(endpointMap.values()).sort(
    (a, b) => b.count - a.count,
  );

  return {
    rest: endpoints.filter((e) => e.style === "REST"),
    graphql: endpoints.filter((e) => e.style === "GraphQL"),
    websockets: wsRecords.map((rec) => ({
      url: rec.value.url,
      host: getHostname(rec.value.url),
    })),
  };
}

export function buildReport({ scanMeta, evidence }) {
  const inferenceResults = runInference(evidence);
  const techStack = buildTechStackSummary(inferenceResults);

  return {
    meta: scanMeta,
    overview: buildOverview(evidence, inferenceResults, scanMeta),
    techStack,
    // Full per-category results (including lower-ranked candidates) kept
    // around for a "show all evidence" view, since the graphs above only
    // surface the top pick per category.
    inference: inferenceResults,
    graphs: {
      dependencyGraph: buildDependencyGraph(inferenceResults),
      requestFlow: buildRequestFlowDiagram(evidence),
      authFlow: buildAuthFlowDiagram(inferenceResults),
      apiMap: buildApiMap(evidence),
    },
  };
}

export {
  buildOverview,
  buildDependencyGraph,
  buildRequestFlowDiagram,
  buildAuthFlowDiagram,
  buildApiMap,
};
