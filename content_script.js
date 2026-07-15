// Runs in the ISOLATED JS world (default for chrome.scripting.executeScript
// with `files`), injected once per scan by service-worker.js. This world
// shares the live DOM with the page but NOT window-level JS objects — so
// this file can read attributes, classes, script tags, and cookies, but
// cannot see things like `window.__NEXT_DATA__` or React internals. Those
// are captured separately by a MAIN-world probe run directly from the
// service worker (see service-worker.js).

(function scan() {
  const records = [];

  function record(source, signal, value) {
    records.push({ source, signal, value });
  }
  //first scan that can basically tell us a lot like the small starting statements we get at the top of inspect
  function scanMetaTags() {
    const metas = document.querySelectorAll("meta");
    metas.forEach((meta) => {
      const name = (
        meta.getAttribute("name") ||
        meta.getAttribute("property") ||
        ""
      ).toLowerCase();
      const content = meta.getAttribute("content") || "";
      if (!content) return;

      if (name === "generator") {
        record("meta", "generator-tag", content);
      }
      if (name === "framework") record("meta", "framework-tag", content);
      if (name.startsWith("og:")) record("meta", "opengraph-present", content);
    });
  }

  function scanScriptTags() {
    const scripts = document.querySelectorAll("script");
    scripts.forEach((script) => {
      if (script.src) {
        record("scripts", "script-src", script);
      } else if (script.textContent.trim().length > 0) {
        record(
          "scripts",
          "inline-script-overview",
          script.textContent.slice(0, 300),
        );
      }
    });

    document.querySelectorAll("link[href]").forEach((link) => {
      const rel = link.getAttribute("rel") || "";
      if (
        [
          "modulepreload",
          "preload",
          "stylesheet",
          "dns-prefetch",
          "preconnect",
        ].includes(rel)
      ) {
        record("scripts", "link-href", { rel, href: link.href });
      }
    });
  }
  //for dom attributes like vue, react, angular
  function scanDomAttributes() {
    const attributeChecks = [
      {
        selector: "[ng-version]",
        signal: "angular-ng-version",
        extract: (el) => el.getAttribute("ng-version"),
      },
      {
        selector: "[data-reactroot]",
        signal: "react-data-reactroot",
        extract: () => true,
      },
      {
        selector: "[data-server-rendered]",
        signal: "vue-data-server-rendered",
        extract: (el) => el.getAttribute("data-server-rendered"),
      },
      {
        selector: "[data-v-app]",
        signal: "vue3-data-v-app",
        extract: () => true,
      },
      {
        selector: "#__next",
        signal: "nextjs-root-element",
        extract: () => true,
      },
      { selector: "#__nuxt", signal: "nuxt-root-element", extract: () => true },
      {
        selector: "astro-island",
        signal: "astro-island-element",
        extract: () => true,
      },
      {
        selector: "[data-svelte-h]",
        signal: "svelte-hydration-marker",
        extract: () => true,
      },
      {
        selector: "[data-remix-run]",
        signal: "remix-marker",
        extract: () => true,
      },
      {
        selector: "gatsby-focus-wrapper, #___gatsby",
        signal: "gatsby-marker",
        extract: () => true,
      },
    ];

    for (const check of attributeChecks) {
      const el = document.querySelector(check.selector);
      if (el) {
        record("dom", check.signal, check.extract(el));
      }
    }

    const vueScopedEl = document.querySelector("[class*='data=v='], [data-v-]");
    if (
      document.querySelector("[class*='data=v='], [data-v-]") ||
      Array.from(document.querySelectorAll("*"))
        .slice(0, 500)
        .some((el) => {
          Array.from(el.attributes || []).some((a) =>
            a.name.startsWith("data-v-"),
          );
        })
    ) {
      record("dom", "vue-scoped-style-attr", true);
    }
  }
  //scan for different css classes present, tailwind , css etc
  function scanClassPatterns() {
    const MAX_ELEMENTS = 800;
    const classSet = new Set();
    const elements = document.querySelectorAll("[class]");

    for (let i = 0; i < elements.length && i < MAX_ELEMENTS; i++) {
      const classList = elements[i].getAttribute("class") || "";
      classList.split(/\s+/).forEach((c) => c && classSet.add(c));
    }
    const classes = Array.from(classSet).slice(0, 2000);

    const patterns = {
      tailwind:
        /^(!?[a-z0-9-]+:)*(sm:|md:|lg:|xl:|2xl:|hover:|focus:|active:|dark:)*(flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|p[xytblr]?-\d|m[xytblr]?-\d|text-(xs|sm|base|lg|xl|\d?xl|[a-z]+-\d{2,3})|bg-[a-z]+-\d{2,3}|w-(\d+|full|screen|auto)|h-(\d+|full|screen|auto)|rounded(-[a-z]+)?|border(-[a-z0-9]+)?|shadow(-[a-z]+)?|gap-\d|flex-(row|col|wrap))$/,
      cssModulesHash: /^[a-zA-Z0-9_-]+_[a-zA-Z0-9]{5,10}$/,
      styledComponents: /^sc-[a-zA-Z0-9]+$/,
      emotionCss: /^css-[a-zA-Z0-9]+$/,
      bem: /^[a-z0-9]+(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$/,
      bootstrap: /^(col|row|btn|navbar|card|modal|container)(-[a-z0-9]+)*$/,
      muiClass: /^Mui[A-Z][a-zA-Z]+-[a-zA-Z]+$/,
      chakraClass: /^chakra-[a-z-]+$/,
      antClass: /^ant-[a-z-]+$/,
    };

    const counts = Object.fromEntries(Object.keys(patterns).map((k) => [k, 0]));
    for (const cls of classes) {
      for (const [name, regex] of Object.entries(patterns)) {
        if (regex.test(cls)) counts[name]++;
      }
    }
    record("css", "class-pattern-counts", {
      ...counts,
      totalClassesSampled: classes.length,
    });
  }

  //for the non http cookies, the http ones are scanned in the service worker file

  function scanReadableCookies() {
    if (!document.cookie) return;
    const names = document.cookie
      .split(";")
      .map((pair) => pair.split("=")[0].trim())
      .filter(Boolean);
    record("cookies", "client-readable-cookie-names", names);
  }

  scanMetaTags();
  scanScriptTags();
  scanDomAttributes();
  scanClassPatterns();
  scanReadableCookies();

  function flush(batch) {
    if (batch.length === 0) return;
    chrome.runtime.sendMessage({ type: "DOM_EVIDENCE", records: batch }, () => {
      void chrome.runtime.lastError;
    });
  }

  flush(records);

  // Late-loading resources: lazy-hydrated components, async chunks, and
  // deferred analytics scripts often appear after first paint. Watch for
  const seenScriptSrcs = new Set(
    records.filter((r) => r.signal === "script-src").map((r) => r.value),
  );
  const observer = new MutationObserver((mutations) => {
    const late = [];
    for (const mutation in mutations) {
      mutation.addedNotes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node;
        if (el.tagName === "SCRIPT" && el.getAttribute("src")) {
          const src = el.getAttribute("src");
          if (!seenScriptSrcs.has(src)) {
            seenScriptSrcs.add(src);
            late.push({
              source: "scripts",
              signal: "script-src-late",
              value: src,
            });
          }
        }
      });
    }
    flush(late);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "STOP_OBSERVING") {
      observer.disconnect();
      sendResponse({ ok: true });
    }
  });

  setTimeout(() => observer.disconnect(), 15000);
})();
