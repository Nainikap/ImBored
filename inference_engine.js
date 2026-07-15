// Turns raw evidence (from evidence-store.js — records shaped like
// {source, signal, value, timestamp}) into scored technology detections.
//
// Design: each technology has a set of independent "checks" against the
// evidence, each with a weight. A tech's confidence = (sum of weights for
// checks that matched) / (sum of weights for all its checks) — normalized
// per-technology so a tech with only 2 available signals isn't unfairly
// penalized against one with 6. No single check is treated as proof; we're
// combining weak/partial signals on purpose, per the project's premise.

//rules

//helper functions
export function bySignal(evidence, signal) {
  return evidence.filter((e) => e.signal === signal);
}

export function bySource(evidence, source) {
  return evidence.filter((e) => e.source === source);
}
function matchesAny(...arrays) {
  return arrays.flat();
}

function headerRecords(evidence) {
  return evidence.filter(
    (e) =>
      e.signal === "response-header" || e.signal === "response-header-extra",
  );
}

function findHeaderMatch(evidence, predicate) {
  const matches = [];
  for (const rec of headerRecords(evidence)) {
    const headers = rec.value?.headers || {};
    for (const [name, value] of Object.entries(headers)) {
      if (predicate(String(name).toLowerCase(), String(value).toLowerCase())) {
        matches.push(rec);
        break;
      }
    }
  }
  return matches;
}

function headerNameIncludes(evidence, nameSubstr) {
  return findHeaderMatch(evidence, (name) => name.includes(nameSubstr));
}

function headerValueIncludes(evidence, nameSubstr, valueSubstr) {
  return findHeaderMatch(
    evidence,
    (value) => value.includes(valueSubstr) && name.includes(nameSubstr),
  );
}

function anyHeaderValueIncludes(evidence, valueSubstr) {
  return findHeaderMatch(evidence, (_name, value) =>
    value.includes(valueSubstr),
  );
}

function scriptSrcRecords(evidence) {
  return evidence.filter(
    (e) => e.signal === "script-src" || e.signal === "script-src-late",
  );
}

function scriptSrcMatches(evidence, regex) {
  return scriptSrcRecords(evidence).filter((e) => regex.test(e.value));
}

function linkHrefRecords(evidence) {
  return evidence.filter((e) => e.signal === "link-href");
}

function linkHrefMatches(evidence, regex) {
  return linkHrefRecords(evidence).filter((e) =>
    regex.test(e.value?.href || ""),
  );
}

function inlineScriptRecords(evidence) {
  return evidence.filter((e) => e.signal === "inline-script-preview");
}

function inlineScriptMatches(evidence, regex) {
  return inlineScriptRecords(evidence).filter((e) => regex.test(e.value));
}

function extractCookieNamesFromSetCookieRaw(raw) {
  if (!raw) return [];
  return String(raw)
    .split("\n")
    .map((line) => line.split(";")[0].split("=")[0].trim())
    .filter(Boolean);
}

function cookieNameRecords(evidence) {
  const out = [];
  for (const e of evidence) {
    if (e.signal === "set-cookie") {
      out.push({
        rec: e,
        names: extractCookieNamesFromSetCookieRaw(e.value?.raw),
      });
    }
    if (e.signal === "client-readable-cookie-names") {
      out.push({ rec: e, names: Array.isArray(e.value) ? e.value : [] });
    }
  }
  return out;
}

function cookieNameMatches(evidence, regex) {
  const matches = [];
  for (const { rec, names } of cookieNameRecords(evidence)) {
    if (names.some((n) => regex.test(n))) matches.push(rec);
  }
  return matches;
}

function requestUrlRecords(evidence) {
  return evidence.filter(
    (e) =>
      e.signal === "request" ||
      e.signal === "response-header" ||
      e.signal === "ws-created",
  );
}

function requestUrlMatches(evidence, regex) {
  return requestUrlRecords(evidence).filter((e) =>
    regex.test(e.value?.url || ""),
  );
}

function websocketRecords(evidence) {
  return evidence.filter((e) => e.source === "websocket");
}

function globalSignal(evidence, signal) {
  return evidence.filter((e) => e.source === "globals" && e.signal === signal);
}

function domSignal(evidence, signal) {
  return evidence.filter((e) => e.source === "dom" && e.signal === signal);
}

function cssPatternRecords(evidence) {
  return evidence.filter((e) => e.signal === "class-pattern-counts");
}

function cssPatternCountAtLeast(evidence, key, min = 1) {
  return cssPatternRecords(evidence).filter(
    (e) => (e.value?.[key] || 0) >= min,
  );
}

function metaSignal(evidence, signal) {
  return evidence.filter((e) => e.source === "meta" && e.signal === signal);
}

function metaContentIncludes(evidence, signal, substr) {
  return metaSignal(evidence, signal).filter((e) =>
    String(e.value || "")
      .toLowerCase()
      .includes(substr),
  );
}

export const RULES = {
  "frontend-framework": [
    {
      id: "nextjs",
      name: "Next.js",
      checks: [
        {
          weight: 35,
          label: "window.__NEXT_DATA__ present",
          test: (ev) => globalSignal(ev, "nextData"),
        },
        {
          weight: 20,
          label: "#__next root element",
          test: (ev) => domSignal(ev, "nextjs-root-element"),
        },
        {
          weight: 20,
          label: "/_next/ script paths",
          test: (ev) => scriptSrcMatches(ev, /\/_next\//),
        },
        {
          weight: 15,
          label: "header mentions Next.js",
          test: (ev) => anyHeaderValueIncludes(ev, "next.js"),
        },
        {
          weight: 10,
          label: "x-vercel-* header (common Next.js host)",
          test: (ev) => headerNameIncludes(ev, "x-vercel"),
        },
      ],
    },
    {
      id: "nuxt",
      name: "Nuxt",
      checks: [
        {
          weight: 35,
          label: "window.__NUXT__ present",
          test: (ev) => globalSignal(ev, "nuxtData"),
        },
        {
          weight: 25,
          label: "#__nuxt root element",
          test: (ev) => domSignal(ev, "nuxt-root-element"),
        },
        {
          weight: 25,
          label: "/_nuxt/ script paths",
          test: (ev) => scriptSrcMatches(ev, /\/_nuxt\//),
        },
        {
          weight: 15,
          label: "'nuxt' keyword in inline scripts",
          test: (ev) => inlineScriptMatches(ev, /\bnuxt\b/i),
        },
      ],
    },
    {
      id: "react",
      name: "React",
      checks: [
        {
          weight: 30,
          label: "React Fiber internal keys found on root element",
          test: (ev) => globalSignal(ev, "reactFiberMarkerFound"),
        },
        {
          weight: 20,
          label: "React DevTools global hook present",
          test: (ev) => globalSignal(ev, "reactDevtoolsHook"),
        },
        {
          weight: 15,
          label: "data-reactroot attribute",
          test: (ev) => domSignal(ev, "react-data-reactroot"),
        },
        {
          weight: 15,
          label: "window.React exposed with version",
          test: (ev) => globalSignal(ev, "reactGlobalVersion"),
        },
        {
          weight: 10,
          label: "react/react-dom in script paths",
          test: (ev) => scriptSrcMatches(ev, /react(-dom)?[.\-]/i),
        },
        {
          weight: 10,
          label: "'react' keyword in inline scripts",
          test: (ev) => inlineScriptMatches(ev, /\breact\b/i),
        },
      ],
    },
    {
      id: "vue",
      name: "Vue.js",
      checks: [
        {
          weight: 25,
          label: "Vue instance marker (__vue__ / __vue_app__) on root element",
          test: (ev) => globalSignal(ev, "vueInstanceMarkerFound"),
        },
        {
          weight: 20,
          label: "Vue DevTools global hook present",
          test: (ev) => globalSignal(ev, "vueDevtoolsHook"),
        },
        {
          weight: 15,
          label: "window.Vue exposed with version",
          test: (ev) => globalSignal(ev, "vueGlobalVersion"),
        },
        {
          weight: 15,
          label: "data-server-rendered attribute (Vue 2 SSR)",
          test: (ev) => domSignal(ev, "vue-data-server-rendered"),
        },
        {
          weight: 15,
          label: "data-v-app attribute (Vue 3)",
          test: (ev) => domSignal(ev, "vue3-data-v-app"),
        },
        {
          weight: 10,
          label: "scoped style data-v-* attributes",
          test: (ev) => domSignal(ev, "vue-scoped-style-attr"),
        },
      ],
    },
    {
      id: "angular",
      name: "Angular",
      checks: [
        {
          weight: 40,
          label: "ng-version attribute present",
          test: (ev) => domSignal(ev, "angular-ng-version"),
        },
        {
          weight: 30,
          label: "Angular root APIs (getAllAngularRootElements / window.ng)",
          test: (ev) => globalSignal(ev, "angularModern"),
        },
        {
          weight: 15,
          label: "Angular script paths",
          test: (ev) => scriptSrcMatches(ev, /@angular|angular\.(min\.)?js/i),
        },
      ],
    },
    {
      id: "angularjs",
      name: "AngularJS (1.x)",
      checks: [
        {
          weight: 50,
          label: "window.angular with version exposed",
          test: (ev) => globalSignal(ev, "angularJsVersion"),
        },
      ],
    },
    {
      id: "svelte",
      name: "Svelte / SvelteKit",
      checks: [
        {
          weight: 40,
          label: "Svelte hydration marker attribute",
          test: (ev) => domSignal(ev, "svelte-hydration-marker"),
        },
        {
          weight: 20,
          label: "'svelte' keyword in script paths",
          test: (ev) => scriptSrcMatches(ev, /svelte/i),
        },
      ],
    },
    {
      id: "astro",
      name: "Astro",
      checks: [
        {
          weight: 45,
          label: "<astro-island> custom element present",
          test: (ev) => domSignal(ev, "astro-island-element"),
        },
        {
          weight: 15,
          label: "'astro' keyword in script paths",
          test: (ev) => scriptSrcMatches(ev, /astro/i),
        },
      ],
    },
    {
      id: "remix",
      name: "Remix",
      checks: [
        {
          weight: 45,
          label: "data-remix-run marker present",
          test: (ev) => domSignal(ev, "remix-marker"),
        },
      ],
    },
    {
      id: "gatsby",
      name: "Gatsby",
      checks: [
        {
          weight: 45,
          label: "Gatsby root wrapper element present",
          test: (ev) => domSignal(ev, "gatsby-marker"),
        },
        {
          weight: 15,
          label: "'gatsby' keyword in script paths",
          test: (ev) => scriptSrcMatches(ev, /gatsby/i),
        },
      ],
    },
    {
      id: "jquery",
      name: "jQuery",
      checks: [
        {
          weight: 40,
          label: "window.jQuery exposed with version",
          test: (ev) => globalSignal(ev, "jqueryVersion"),
        },
        {
          weight: 15,
          label: "'jquery' in script paths",
          test: (ev) => scriptSrcMatches(ev, /jquery/i),
        },
      ],
    },
  ],

  "css-library": [
    {
      id: "tailwind",
      name: "Tailwind CSS",
      checks: [
        {
          weight: 60,
          label: "high density of Tailwind-style utility classes",
          test: (ev) => cssPatternCountAtLeast(ev, "tailwind", 8),
        },
        {
          weight: 20,
          label: "some Tailwind-style utility classes present",
          test: (ev) => cssPatternCountAtLeast(ev, "tailwind", 1),
        },
      ],
    },
    {
      id: "css-modules",
      name: "CSS Modules",
      checks: [
        {
          weight: 60,
          label: "hashed CSS Modules class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "cssModulesHash", 5),
        },
      ],
    },
    {
      id: "styled-components",
      name: "styled-components",
      checks: [
        {
          weight: 60,
          label: "sc-* generated class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "styledComponents", 3),
        },
      ],
    },
    {
      id: "emotion",
      name: "Emotion",
      checks: [
        {
          weight: 60,
          label: "css-* generated class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "emotionCss", 3),
        },
      ],
    },
    {
      id: "bootstrap",
      name: "Bootstrap",
      checks: [
        {
          weight: 50,
          label: "Bootstrap grid/utility class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "bootstrap", 5),
        },
        {
          weight: 15,
          label: "'bootstrap' in script/link paths",
          test: (ev) =>
            matchesAny(
              scriptSrcMatches(ev, /bootstrap/i),
              linkHrefMatches(ev, /bootstrap/i),
            ),
        },
      ],
    },
    {
      id: "mui",
      name: "Material UI (MUI)",
      checks: [
        {
          weight: 60,
          label: "Mui* class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "muiClass", 3),
        },
      ],
    },
    {
      id: "chakra",
      name: "Chakra UI",
      checks: [
        {
          weight: 60,
          label: "chakra-* class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "chakraClass", 3),
        },
      ],
    },
    {
      id: "antd",
      name: "Ant Design",
      checks: [
        {
          weight: 60,
          label: "ant-* class names present",
          test: (ev) => cssPatternCountAtLeast(ev, "antClass", 3),
        },
      ],
    },
  ],

  "build-tool": [
    {
      id: "webpack",
      name: "Webpack",
      checks: [
        {
          weight: 40,
          label: "webpackJsonp/__webpack_require__ keywords inline",
          test: (ev) =>
            inlineScriptMatches(
              ev,
              /webpackJsonp|__webpack_require__|webpackChunk/i,
            ),
        },
        {
          weight: 20,
          label: "hashed chunk.js style script naming",
          test: (ev) =>
            scriptSrcMatches(
              ev,
              /\.[a-f0-9]{8,20}\.chunk\.js|\.[a-f0-9]{8,20}\.js(\?|$)/i,
            ),
        },
      ],
    },
    {
      id: "vite",
      name: "Vite",
      checks: [
        {
          weight: 35,
          label: "/assets/*-[hash].js Vite build naming",
          test: (ev) =>
            scriptSrcMatches(ev, /\/assets\/[^"']+-[a-zA-Z0-9_]{8}\.js/),
        },
        {
          weight: 20,
          label: "'vite' keyword inline",
          test: (ev) => inlineScriptMatches(ev, /\bvite\b/i),
        },
        {
          weight: 15,
          label: "modulepreload links (common Vite/ESM output)",
          test: (ev) =>
            linkHrefRecords(ev).filter((e) => e.value?.rel === "modulepreload"),
        },
      ],
    },
  ],

  "backend-technology": [
    {
      id: "php",
      name: "PHP",
      checks: [
        {
          weight: 40,
          label: "PHPSESSID cookie present",
          test: (ev) => cookieNameMatches(ev, /^PHPSESSID$/i),
        },
        {
          weight: 30,
          label: "X-Powered-By header mentions PHP",
          test: (ev) => headerValueIncludes(ev, "x-powered-by", "php"),
        },
      ],
    },
    {
      id: "aspnet",
      name: "ASP.NET",
      checks: [
        {
          weight: 40,
          label: "ASP.NET_SessionId cookie present",
          test: (ev) => cookieNameMatches(ev, /ASP\.NET_SessionId/i),
        },
        {
          weight: 30,
          label: "ASP.NET header present (X-Powered-By / X-AspNet-Version)",
          test: (ev) =>
            matchesAny(
              headerValueIncludes(ev, "x-powered-by", "asp.net"),
              headerNameIncludes(ev, "x-aspnet-version"),
              headerNameIncludes(ev, "x-aspnetmvc-version"),
            ),
        },
      ],
    },
    {
      id: "express",
      name: "Express / Node.js",
      checks: [
        {
          weight: 35,
          label: "connect.sid cookie (express-session default)",
          test: (ev) => cookieNameMatches(ev, /^connect\.sid$/i),
        },
        {
          weight: 20,
          label: "X-Powered-By header mentions Express",
          test: (ev) => headerValueIncludes(ev, "x-powered-by", "express"),
        },
      ],
    },
    {
      id: "laravel",
      name: "Laravel (PHP)",
      checks: [
        {
          weight: 45,
          label: "laravel_session cookie present",
          test: (ev) => cookieNameMatches(ev, /laravel_session/i),
        },
        {
          weight: 20,
          label: "XSRF-TOKEN cookie (Laravel default CSRF cookie)",
          test: (ev) => cookieNameMatches(ev, /^XSRF-TOKEN$/i),
        },
      ],
    },
    {
      id: "django",
      name: "Django (Python)",
      checks: [
        {
          weight: 45,
          label: "csrftoken / sessionid cookies (Django defaults)",
          test: (ev) =>
            matchesAny(
              cookieNameMatches(ev, /^csrftoken$/i),
              cookieNameMatches(ev, /^sessionid$/i),
            ),
        },
      ],
    },
    {
      id: "rails",
      name: "Ruby on Rails",
      checks: [
        {
          weight: 45,
          label: "_session cookie naming pattern typical of Rails",
          test: (ev) => cookieNameMatches(ev, /_session$/i),
        },
        {
          weight: 15,
          label: "X-Runtime header (common Rails signature)",
          test: (ev) => headerNameIncludes(ev, "x-runtime"),
        },
      ],
    },
    {
      id: "apache",
      name: "Apache HTTP Server",
      checks: [
        {
          weight: 40,
          label: "Server header mentions Apache",
          test: (ev) => headerValueIncludes(ev, "server", "apache"),
        },
      ],
    },
    {
      id: "nginx",
      name: "Nginx",
      checks: [
        {
          weight: 40,
          label: "Server header mentions nginx",
          test: (ev) => headerValueIncludes(ev, "server", "nginx"),
        },
      ],
    },
  ],

  "hosting-platform": [
    {
      id: "vercel",
      name: "Vercel",
      checks: [
        {
          weight: 50,
          label: "x-vercel-* header present",
          test: (ev) => headerNameIncludes(ev, "x-vercel"),
        },
      ],
    },
    {
      id: "netlify",
      name: "Netlify",
      checks: [
        {
          weight: 50,
          label: "x-nf-request-id header or Server: Netlify",
          test: (ev) =>
            matchesAny(
              headerNameIncludes(ev, "x-nf-request-id"),
              headerValueIncludes(ev, "server", "netlify"),
            ),
        },
      ],
    },
    {
      id: "cloudflare",
      name: "Cloudflare",
      checks: [
        {
          weight: 45,
          label: "cf-ray / cf-cache-status header present",
          test: (ev) =>
            matchesAny(
              headerNameIncludes(ev, "cf-ray"),
              headerNameIncludes(ev, "cf-cache-status"),
            ),
        },
      ],
    },
    {
      id: "aws-cloudfront",
      name: "AWS CloudFront",
      checks: [
        {
          weight: 45,
          label: "x-amz-cf-id header or Via: CloudFront",
          test: (ev) =>
            matchesAny(
              headerNameIncludes(ev, "x-amz-cf-id"),
              headerValueIncludes(ev, "via", "cloudfront"),
            ),
        },
      ],
    },
    {
      id: "fastly",
      name: "Fastly",
      checks: [
        {
          weight: 45,
          label: "x-fastly-request-id / x-served-by header present",
          test: (ev) =>
            matchesAny(
              headerNameIncludes(ev, "x-fastly-request-id"),
              headerNameIncludes(ev, "x-served-by"),
            ),
        },
      ],
    },
    {
      id: "github-pages",
      name: "GitHub Pages",
      checks: [
        {
          weight: 45,
          label: "Server header mentions GitHub.com",
          test: (ev) => headerValueIncludes(ev, "server", "github.com"),
        },
      ],
    },
    {
      id: "firebase-hosting",
      name: "Firebase Hosting",
      checks: [
        {
          weight: 45,
          label: "Server header or script domain mentions Firebase",
          test: (ev) =>
            matchesAny(
              headerValueIncludes(ev, "server", "firebase"),
              scriptSrcMatches(ev, /firebaseapp\.com|firebaseio\.com/i),
            ),
        },
      ],
    },
    {
      id: "shopify-hosting",
      name: "Shopify",
      checks: [
        {
          weight: 50,
          label: "window.Shopify global present",
          test: (ev) => globalSignal(ev, "shopifyGlobal"),
        },
      ],
    },
    {
      id: "wordpress-hosting",
      name: "WordPress",
      checks: [
        {
          weight: 35,
          label: "wp-content / wp-includes script paths",
          test: (ev) => scriptSrcMatches(ev, /wp-content|wp-includes/i),
        },
        {
          weight: 20,
          label: "generator meta tag mentions WordPress",
          test: (ev) => metaContentIncludes(ev, "generator-tag", "wordpress"),
        },
        {
          weight: 15,
          label: "window.wp global present",
          test: (ev) => globalSignal(ev, "wordpressGlobal"),
        },
      ],
    },
  ],

  "api-style": [
    {
      id: "graphql",
      name: "GraphQL",
      checks: [
        {
          weight: 50,
          label: "/graphql endpoint requested",
          test: (ev) => requestUrlMatches(ev, /\/graphql/i),
        },
        {
          weight: 25,
          label: "Apollo Client state present",
          test: (ev) => globalSignal(ev, "apolloGraphqlState"),
        },
      ],
    },
    {
      id: "rest",
      name: "REST",
      checks: [
        {
          weight: 35,
          label: "/api/ path requests observed",
          // Only counts if no GraphQL endpoint was seen — avoids double-
          // counting a GraphQL-only API as "REST" just because /api/graphql
          // itself matches a loose /api/ prefix check.
          test: (ev) =>
            requestUrlMatches(ev, /\/graphql/i).length > 0
              ? []
              : requestUrlMatches(ev, /\/api\//i),
        },
      ],
    },
    {
      id: "websocket-api",
      name: "WebSocket",
      checks: [
        {
          weight: 50,
          label: "WebSocket connection observed",
          test: (ev) => websocketRecords(ev),
        },
      ],
    },
  ],

  "auth-mechanism": [
    {
      id: "session-cookie-auth",
      name: "Server-side session cookie",
      checks: [
        {
          weight: 35,
          label: "session-style cookie observed",
          test: (ev) =>
            cookieNameMatches(ev, /session|sid|phpsessid|jsessionid/i),
        },
      ],
    },
    {
      id: "jwt-auth",
      name: "JWT / bearer token",
      checks: [
        {
          weight: 35,
          label: "token-named cookie or token endpoint observed",
          test: (ev) =>
            matchesAny(
              cookieNameMatches(ev, /jwt|access_token|id_token/i),
              requestUrlMatches(ev, /\/oauth\/token|\/token\b/i),
            ),
        },
      ],
    },
    {
      id: "auth0",
      name: "Auth0",
      checks: [
        {
          weight: 50,
          label: "auth0.com domain referenced",
          test: (ev) =>
            matchesAny(
              scriptSrcMatches(ev, /auth0\.com/i),
              requestUrlMatches(ev, /auth0\.com/i),
            ),
        },
      ],
    },
    {
      id: "firebase-auth",
      name: "Firebase Authentication",
      checks: [
        {
          weight: 45,
          label: "Firebase auth endpoints referenced",
          test: (ev) =>
            matchesAny(
              requestUrlMatches(ev, /identitytoolkit\.googleapis\.com/i),
              scriptSrcMatches(ev, /firebaseapp\.com/i),
            ),
        },
      ],
    },
    {
      id: "clerk-auth",
      name: "Clerk",
      checks: [
        {
          weight: 50,
          label: "clerk.dev / clerk.accounts.dev referenced",
          test: (ev) =>
            matchesAny(
              scriptSrcMatches(ev, /clerk\.(dev|com|accounts\.dev)/i),
              requestUrlMatches(ev, /clerk\.(dev|com|accounts\.dev)/i),
            ),
        },
      ],
    },
    {
      id: "supabase-auth",
      name: "Supabase Auth",
      checks: [
        {
          weight: 45,
          label: "supabase.co auth endpoint referenced",
          test: (ev) => requestUrlMatches(ev, /supabase\.co\/auth/i),
        },
      ],
    },
  ],

  // Databases are rarely visible from the browser at all — these are
  // intentionally narrow, low-confidence rules for the few cases where a
  // client-side SDK talks to the database's HTTP API directly.
  database: [
    {
      id: "supabase-db",
      name: "Supabase (Postgres)",
      checks: [
        {
          weight: 50,
          label: "supabase.co data endpoint referenced",
          test: (ev) => requestUrlMatches(ev, /supabase\.co/i),
        },
      ],
    },
    {
      id: "firebase-db",
      name: "Firebase Realtime Database / Firestore",
      checks: [
        {
          weight: 50,
          label:
            "firebaseio.com / firestore.googleapis.com endpoint referenced",
          test: (ev) =>
            requestUrlMatches(
              ev,
              /firebaseio\.com|firestore\.googleapis\.com/i,
            ),
        },
      ],
    },
  ],

  "third-party-integration": [
    {
      id: "google-analytics",
      name: "Google Analytics",
      checks: [
        {
          weight: 30,
          label: "window.gtag / window.ga present",
          test: (ev) =>
            matchesAny(
              globalSignal(ev, "gtagPresent"),
              globalSignal(ev, "gaPresent"),
            ),
        },
        {
          weight: 25,
          label: "google-analytics.com / googletagmanager.com script loaded",
          test: (ev) =>
            scriptSrcMatches(
              ev,
              /google-analytics\.com|googletagmanager\.com/i,
            ),
        },
      ],
    },
    {
      id: "google-tag-manager",
      name: "Google Tag Manager",
      checks: [
        {
          weight: 40,
          label: "window.dataLayer present",
          test: (ev) => globalSignal(ev, "gtmDataLayer"),
        },
        {
          weight: 20,
          label: "googletagmanager.com script loaded",
          test: (ev) => scriptSrcMatches(ev, /googletagmanager\.com/i),
        },
      ],
    },
    {
      id: "stripe",
      name: "Stripe",
      checks: [
        {
          weight: 35,
          label: "window.Stripe present",
          test: (ev) => globalSignal(ev, "stripeGlobal"),
        },
        {
          weight: 20,
          label: "js.stripe.com script loaded",
          test: (ev) => scriptSrcMatches(ev, /js\.stripe\.com/i),
        },
      ],
    },
    {
      id: "recaptcha",
      name: "Google reCAPTCHA",
      checks: [
        {
          weight: 35,
          label: "window.grecaptcha present",
          test: (ev) => globalSignal(ev, "recaptchaGlobal"),
        },
        {
          weight: 20,
          label: "recaptcha script loaded",
          test: (ev) => scriptSrcMatches(ev, /recaptcha/i),
        },
      ],
    },
    {
      id: "sentry",
      name: "Sentry",
      checks: [
        {
          weight: 35,
          label: "window.Sentry present",
          test: (ev) => globalSignal(ev, "sentryGlobal"),
        },
        {
          weight: 20,
          label: "sentry script loaded",
          test: (ev) => scriptSrcMatches(ev, /sentry/i),
        },
      ],
    },
    {
      id: "intercom",
      name: "Intercom",
      checks: [
        {
          weight: 35,
          label: "window.Intercom present",
          test: (ev) => globalSignal(ev, "intercomGlobal"),
        },
        {
          weight: 20,
          label: "Intercom widget script loaded",
          test: (ev) => scriptSrcMatches(ev, /intercom/i),
        },
      ],
    },
    {
      id: "segment",
      name: "Segment",
      checks: [
        {
          weight: 35,
          label: "window.analytics (Segment) present",
          test: (ev) => globalSignal(ev, "segmentGlobal"),
        },
        {
          weight: 20,
          label: "cdn.segment.com script loaded",
          test: (ev) => scriptSrcMatches(ev, /cdn\.segment\.com/i),
        },
      ],
    },
  ],
};

const MIN_CONFIDENCE = 0.15;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function evaluateRule(evidence, rule) {
  let matchedWeight = 0;
  let totalWeight = 0;
  const matchedChecks = [];

  for (const check of rule.checks) {
    totalWeight += check.weight;
    const matched = check.test(evidence) || [];
    if (matched.length > 0) {
      matchedWeight += check.weight;
      matchedChecks.push({
        label: check.label,
        weight: check.weight,
        evidence: matched,
      });
    }
  }

  const confidence =
    totalWeight > 0 ? clamp(matchedWeight / totalWeight, 0, 1) : 0;

  return {
    id: rule.id,
    name: rule.name,
    confidence,
    matchedWeight,
    totalWeight,
    matchedChecks,
  };
}

export function runInference(evidence) {
  const results = {};
  for (const [category, rules] of Object.entries(RULES)) {
    results[category] = rules
      .map((rule) => evaluateRule(evidence, rule))
      .filter((r) => r.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence);
  }
  return results;
}

export function buildTechStackSummary(inferenceResults) {
  const summary = {};
  for (const [category, results] of Object.entries(inferenceResults)) {
    summary[category] =
      category === "third-party-integration" ? results : results.slice(0, 3);
  }
  return summary;
}

export function getRules() {
  return RULES;
}
export const CONFIG = { MIN_CONFIDENCE };
