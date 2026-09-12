/*
  Audits the BUILT HTML in dist/, not the source.

  Source review catches intent. This catches what a customer actually receives,
  which is the only thing that counts for either the law or the Lighthouse
  score. A component can look correct and still render a page with two h1
  elements, or an image with no dimensions, or a footer missing the disclosure
  that has to appear on every page.

  Run after `astro build`. Part of `npm run verify`.
*/

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "node-html-parser";

/*
  The Armenian faces are subsetted by scripts/subset-fonts.mjs down to the
  characters the site actually uses, which took 60 KB off every page. The
  hazard of subsetting is that new text renders as boxes and nothing says so,
  so the generated pages are checked against the subset manifest.
*/
let armenianSubset = null;
try {
  const raw = await readFile(
    new URL("../src/styles/armenian-subset.json", import.meta.url),
    "utf8",
  );
  armenianSubset = new Set(JSON.parse(raw).codepoints);
} catch {
  /* No manifest means the fonts were never subsetted. Nothing to enforce. */
}

const isArmenian = (cp) =>
  (cp >= 0x0530 && cp <= 0x058f) || (cp >= 0xfb13 && cp <= 0xfb17);

const DIST = join(process.cwd(), "dist");

/* The same value astro.config.mjs builds with, so a canonical is checked
   against the origin the build actually used rather than a guess. */
const SITE = (process.env.PUBLIC_SITE_URL || "https://hakopsbakery.com").replace(/\/+$/, "");

const RED = "\x1b[31m", YEL = "\x1b[33m", GRN = "\x1b[32m";
const DIM = "\x1b[2m", RST = "\x1b[0m";

/*
  The law asks for THREE values, not one: the home kitchen statement, the
  county that approved the registration, and the registration number itself.
  See docs/COMPLIANCE.md section 3 and src/config/site.ts.

  This check used to look for the loose substring "made in a home kitchen",
  which the section heading on the order page satisfies on its own, so a page
  whose actual sentence had been replaced by a paraphrase still passed. It
  also never looked for the county or the number at all. All three are
  asserted now, and the statement is matched in full.
*/

/**
 * The required sentence, read out of the one module that owns it rather than
 * retyped here. Retyping it would mean this guard could pass while the site
 * and the printed label disagreed, which is the failure it exists to catch.
 */
async function homeKitchenStatement() {
  const source = await readFile(
    new URL("../src/config/compliance-text.ts", import.meta.url),
    "utf8",
  );
  const match = /HOME_KITCHEN_STATEMENT\s*=\s*"([^"]+)"/.exec(source);
  if (match === null) {
    console.error(
      `${RED}Could not read HOME_KITCHEN_STATEMENT out of ` +
        `src/config/compliance-text.ts. Nothing is checking the disclosure.${RST}`,
    );
    process.exit(1);
  }
  return match[1];
}

const envText = (key) => String(process.env[key] ?? "").trim();

/* Text that must appear on every single page. These are the legal ones. */
const REQUIRED_ON_EVERY_PAGE = [
  {
    id: "home-kitchen-statement",
    needle: (await homeKitchenStatement()).toLowerCase(),
    why:
      "California requires a cottage food operation that advertises to the\n" +
      "        public, which includes its own website, to carry this statement\n" +
      "        word for word. A paraphrase does not satisfy it.",
  },
  {
    /* site.ts falls back to Orange County, so a page always shows one. */
    id: "county",
    needle: (envText("PUBLIC_CFO_COUNTY") || "Orange County").toLowerCase(),
    why:
      "The county that approved the registration has to appear wherever the\n" +
      "        operation advertises. Set PUBLIC_CFO_COUNTY to match the county.",
  },
];

/*
  ComplianceLine prints the number whenever the registration number and the
  county are both configured, which is exactly `complianceIsComplete` in
  src/config/site.ts. When there is no number the component says the
  application is in progress instead, and there is nothing to assert.
*/
const REGISTRATION_NUMBER = envText("PUBLIC_CFO_REGISTRATION_NUMBER");
if (REGISTRATION_NUMBER !== "") {
  REQUIRED_ON_EVERY_PAGE.push({
    id: "registration-number",
    needle: REGISTRATION_NUMBER.toLowerCase(),
    why:
      "PUBLIC_CFO_REGISTRATION_NUMBER is set, so every page has to carry the\n" +
      "        number. A page that advertises without it is out of compliance.",
  });
}

async function* htmlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(full);
    else if (e.name.endsWith(".html")) yield full;
  }
}

/**
 * The route a built file answers to. `faq/allergens/index.html` is `/faq/`
 * plus `allergens/`, and `404.html` is `/404/`, which is what its canonical
 * says and what Netlify serves it as.
 */
const routeOf = (rel) => {
  const path = "/" + rel.split(/[\\/]/).join("/");
  if (path.endsWith("/index.html")) return path.slice(0, -"index.html".length);
  return path.replace(/\.html$/, "/");
};

/** A root relative href as a route: no query, no fragment, one trailing slash. */
const routeOfHref = (href) => {
  const path = href.split("#")[0].split("?")[0];
  if (path === "") return null;
  if (path.endsWith(".html")) return path.replace(/\.html$/, "/");
  return path.endsWith("/") ? path : `${path}/`;
};

const problems = [];
const warnings = [];
/** Everything the cross page pass below needs, one entry per built page. */
const docs = [];
let pages = 0;

for await (const file of htmlFiles(DIST)) {
  const rel = relative(DIST, file);
  const html = await readFile(file, "utf8");
  const root = parse(html, { comment: false });
  pages += 1;

  const fail = (id, msg) => problems.push({ rel, id, msg });
  const warn = (id, msg) => warnings.push({ rel, id, msg });

  /* ---- Document basics ---- */

  const htmlEl = root.querySelector("html");
  if (!htmlEl?.getAttribute("lang")) {
    fail("lang", "The html element has no lang attribute. Screen readers need it to pick a voice.");
  }

  const title = root.querySelector("title")?.text?.trim() ?? "";
  if (!title) fail("title", "No title element.");
  else if (title.length > 70) warn("title-long", `Title is ${title.length} characters. Search results cut off near 60.`);

  const desc = root.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
  if (!desc) fail("description", "No meta description.");
  else if (desc.length > 175) {
    warn(
      "description-long",
      `Meta description is ${desc.length} characters. A search result cuts one off nearer 160, ` +
        "so everything past that is written for nobody.",
    );
  }

  /*
    Kept for the cross page pass. A title, a description and a trail can only
    be judged against the rest of the build: on its own, a page cannot tell
    that a sibling is claiming the same sentence.
  */
  docs.push({
    rel,
    route: routeOf(rel),
    title,
    desc,
    canonical: root.querySelector('link[rel="canonical"]')?.getAttribute("href")?.trim() ?? "",
    noindex: /noindex/i.test(
      root.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "",
    ),
    jsonld: root.querySelectorAll('script[type="application/ld+json"]').map((s) => s.rawText),
    hrefs: root
      .querySelectorAll("a[href]")
      .map((a) => a.getAttribute("href"))
      .filter((href) => href && !/^(https?:|mailto:|tel:|#|\/\/)/.test(href)),
  });

  const viewport = root.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
  if (!viewport.includes("width=device-width")) {
    fail("viewport", "The viewport meta tag is missing or does not set width=device-width.");
  }
  if (!viewport.includes("viewport-fit=cover")) {
    warn("viewport-fit", "viewport-fit=cover is absent, so env(safe-area-inset-*) resolves to zero on a notched iPhone.");
  }

  /*
    ---- The label QR route ships no JavaScript ----

    This page is printed on the tray and scanned in a kitchen, on cellular, by
    somebody who wants to know right now whether there is a nut in it. Its spec
    is zero script, and Astro's prefetch runtime lands on every page by default,
    so src/integrations/zero-js-routes.mjs takes it back off this route. If that
    integration is removed, misconfigured, or defeated by an Astro change, the
    page quietly grows a script again and nobody notices. This is the assertion
    that makes it loud.
  */
  if (rel.startsWith("p/") || rel.startsWith("p\\")) {
    const scripts = root
      .querySelectorAll("script")
      .filter((s) => s.getAttribute("src"));
    if (scripts.length > 0) {
      fail(
        "label-zero-js",
        `The label QR page loads ${scripts.length} script file(s) ` +
          `(${scripts.map((s) => s.getAttribute("src")).join(", ")}). ` +
          "This route is specified as zero JavaScript.",
      );
    }
  }

  /* ---- Landmarks ---- */

  if (!root.querySelector("main")) fail("landmark-main", "No main element.");
  if (root.querySelectorAll("main").length > 1) fail("landmark-main", "More than one main element.");
  if (!root.querySelector("header")) fail("landmark-header", "No header element.");
  if (!root.querySelector("footer")) fail("landmark-footer", "No footer element.");

  for (const nav of root.querySelectorAll("nav")) {
    if (!nav.getAttribute("aria-label") && !nav.getAttribute("aria-labelledby")) {
      fail("nav-label", "A nav element has no accessible name. With more than one nav on a page they become indistinguishable.");
    }
  }

  const skip = root.querySelector('a[href^="#"]');
  if (!skip || !/skip/i.test(skip.text)) {
    warn("skip-link", "No skip link found as the first in page anchor.");
  }

  /* ---- Headings ---- */

  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  const h1s = headings.filter((h) => h.tagName === "H1");

  if (h1s.length === 0) fail("h1-missing", "No h1 on the page.");
  if (h1s.length > 1) fail("h1-multiple", `${h1s.length} h1 elements. There should be exactly one.`);

  let previous = 0;
  for (const h of headings) {
    const level = Number(h.tagName.slice(1));
    if (previous !== 0 && level > previous + 1) {
      fail(
        "heading-skip",
        `Heading level jumps from h${previous} to h${level} at "${h.text.trim().slice(0, 40)}". ` +
          "Screen reader users navigate by these.",
      );
    }
    previous = level;
  }

  /* ---- Images ---- */

  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "(no src)";
    const alt = img.getAttribute("alt");
    const w = img.getAttribute("width");
    const h = img.getAttribute("height");

    if (alt === null || alt === undefined) {
      fail("img-alt", `Image has no alt attribute at all: ${src}. Use alt="" if it is decorative.`);
    } else if (/^\s*(image|photo|picture|pic)\s+(of|showing)/i.test(alt)) {
      fail("img-alt-lazy", `Alt text starts with "image of": ${src}. Describe the food instead.`);
    }

    if (!w || !h) {
      fail(
        "img-dimensions",
        `Image is missing explicit width or height: ${src}. ` +
          "Without both, the page shifts as photos load and Cumulative Layout Shift goes up.",
      );
    }
  }

  /* ---- Forms ---- */

  for (const control of root.querySelectorAll("input, select, textarea")) {
    const type = (control.getAttribute("type") ?? "text").toLowerCase();
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;

    const id = control.getAttribute("id");
    const labelled =
      control.getAttribute("aria-label") ||
      control.getAttribute("aria-labelledby") ||
      (id && root.querySelector(`label[for="${id}"]`));

    if (!labelled) {
      fail(
        "input-label",
        `A ${type} control has no label. A placeholder is not a label: it disappears as soon as someone types.`,
      );
    }
  }

  /* ---- Layout traps ---- */

  if (/\b100vh\b/.test(html)) {
    fail(
      "100vh",
      "100vh appears in the output. It is the most common cause of layout breaking under mobile browser chrome. Use 100dvh or svh.",
    );
  }

  /* ---- Copy ---- */

  const bodyText = root.querySelector("body")?.text ?? "";
  const EM_DASH = /[\u2014\u2015]/; // escaped so this file stays clean
  if (EM_DASH.test(bodyText)) {
    const at = bodyText.search(EM_DASH);
    fail("em-dash", `An em dash reached the rendered page near: "${bodyText.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ").trim()}"`);
  }

  /* ---- Armenian text outside the subsetted glyph set ---- */

  if (armenianSubset) {
    const missing = new Set();
    for (const ch of bodyText) {
      const cp = ch.codePointAt(0);
      if (isArmenian(cp) && !armenianSubset.has(cp)) missing.add(ch);
    }
    if (missing.size > 0) {
      fail(
        "armenian-not-subsetted",
        `Armenian characters on this page are not in the subsetted fonts: ${[...missing].join(" ")}.\n` +
          "        They will render in a fallback face or as boxes. Run npm run fonts:subset\n" +
          "        and commit the result.",
      );
    }
  }

  /* ---- The legal requirement ---- */

  /* Collapsed, so a sentence broken across lines in the markup still reads
     as one string here. */
  const lower = bodyText.toLowerCase().replace(/\s+/g, " ");
  for (const rule of REQUIRED_ON_EVERY_PAGE) {
    if (!lower.includes(rule.needle.replace(/\s+/g, " "))) {
      fail(
        "compliance",
        `Required disclosure text is missing from this page: ${rule.id}.\n        ${rule.why}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* The cross page pass                                                 */
/*                                                                     */
/* Everything above judges one page on its own. These cannot be: a     */
/* title is only a duplicate next to another title, a page is only an  */
/* orphan when nothing else links to it, and a breadcrumb is only      */
/* correct if the trail above it exists.                               */
/*                                                                     */
/* This exists because of docs/DECISIONS.md D-008, which split the     */
/* questions page and the gata explainer into a page per answer. That  */
/* is worth doing only if each new page carries a title, a description */
/* and a position of its own. Two split pages sharing a description is */
/* worse than the one page they came from, and it is invisible from    */
/* inside either file.                                                 */
/* ------------------------------------------------------------------ */

const crossFail = (id, rel, msg) => problems.push({ rel, id, msg });
const crossWarn = (id, rel, msg) => warnings.push({ rel, id, msg });

const routes = new Set(docs.map((d) => d.route));
const byRoute = new Map(docs.map((d) => [d.route, d]));

/* Only pages a search engine is allowed to keep. A noindex page cannot
   compete with anything, so it is exempt from the duplication rules. */
const indexable = docs.filter((d) => !d.noindex);

/* ---- Canonical ---- */

for (const d of docs) {
  const want = `${SITE}${d.route}`;
  if (d.canonical === "") {
    crossFail("canonical", d.rel, "No canonical link. Every page has to name itself.");
  } else if (d.canonical !== want) {
    crossFail(
      "canonical",
      d.rel,
      `Canonical is ${d.canonical}, and this page is served at ${want}.\n` +
        "        A canonical pointing anywhere but at the page carrying it hands its\n" +
        "        ranking to whatever it names.",
    );
  }
}

/* ---- One title and one description per page ---- */

const groupBy = (list, key) => {
  const m = new Map();
  for (const item of list) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
};

for (const [value, sharing] of groupBy(indexable, (d) => d.title.toLowerCase())) {
  if (value !== "" && sharing.length > 1) {
    crossFail(
      "duplicate-title",
      sharing[0].rel,
      `${sharing.length} pages share the title "${sharing[0].title}":\n` +
        `        ${sharing.map((d) => d.route).join(", ")}\n` +
        "        A search engine picks one of them and drops the rest.",
    );
  }
}

for (const [value, sharing] of groupBy(indexable, (d) => d.desc.toLowerCase())) {
  if (value !== "" && sharing.length > 1) {
    crossFail(
      "duplicate-description",
      sharing[0].rel,
      `${sharing.length} pages share a meta description:\n` +
        `        ${sharing.map((d) => d.route).join(", ")}\n` +
        `        "${sharing[0].desc}"`,
    );
  }
}

/*
  Near duplicates, which is the failure that actually happens. Nobody pastes
  a description twice. What happens is that a page is split and the halves
  keep the same opening sentence, so both results read identically down to
  where the snippet is cut off.
*/
const SHARED_OPENING = 60;

const sharedPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/** Word trigrams, for the pairs that differ at the start and nowhere else. */
const trigrams = (value) => {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 2 < words.length; i += 1) out.add(words.slice(i, i + 3).join(" "));
  return out;
};

const overlap = (a, b) => {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / (left.size + right.size - shared);
};

for (let i = 0; i < indexable.length; i += 1) {
  for (let j = i + 1; j < indexable.length; j += 1) {
    const a = indexable[i];
    const b = indexable[j];
    if (a.desc === "" || b.desc === "" || a.desc === b.desc) continue;

    const opening = sharedPrefix(a.desc, b.desc);
    if (opening >= SHARED_OPENING) {
      crossFail(
        "near-duplicate-description",
        a.rel,
        `${a.route} and ${b.route} open their descriptions with the same ${opening} characters.\n` +
          "        A snippet is cut off around 160, so both results read as the same page.\n" +
          `        "${a.desc.slice(0, opening)}"`,
      );
      continue;
    }

    const score = overlap(a.desc, b.desc);
    if (score >= 0.5) {
      crossWarn(
        "similar-description",
        a.rel,
        `${a.route} and ${b.route} have descriptions that are ${Math.round(score * 100)} percent the same phrasing.\n` +
          "        Worth a look: two pages competing for one query win it less often than one would.",
      );
    }
  }
}

/* ---- BreadcrumbList ---- */

for (const d of docs) {
  for (const raw of d.jsonld) {
    let data;
    try {
      /* Base.astro and Breadcrumbs.astro both escape "<" on the way in, so
         it has to come back out before this parses. */
      data = JSON.parse(raw.replace(/\\u003c/g, "<"));
    } catch (error) {
      crossFail("json-ld-invalid", d.rel, `A JSON-LD block does not parse: ${error.message}`);
      continue;
    }

    for (const node of Array.isArray(data) ? data : [data]) {
      if (node?.["@type"] !== "BreadcrumbList") continue;

      const errs = [];
      if (node["@context"] !== "https://schema.org") {
        errs.push(`@context is ${JSON.stringify(node["@context"])}, not "https://schema.org"`);
      }

      const items = node.itemListElement;
      if (!Array.isArray(items) || items.length === 0) {
        errs.push("itemListElement is not a non empty array");
      } else {
        items.forEach((item, index) => {
          if (item?.["@type"] !== "ListItem") errs.push(`item ${index} is not a ListItem`);
          if (item?.position !== index + 1) {
            errs.push(
              `item ${index} has position ${item?.position}, and positions run from 1 without a gap`,
            );
          }
          if (!item?.name) errs.push(`item ${index} has no name`);

          const url = typeof item?.item === "string" ? item.item : item?.item?.["@id"];
          if (!url) {
            errs.push(`item ${index} has no item URL`);
          } else if (!url.startsWith(`${SITE}/`) && url !== SITE) {
            errs.push(`item ${index} points at ${url}, which is not an absolute URL on this site`);
          } else if (!routes.has(url.slice(SITE.length))) {
            errs.push(`item ${index} points at ${url}, and no page was built there`);
          }
        });

        const last = items[items.length - 1];
        const lastUrl = typeof last?.item === "string" ? last.item : last?.item?.["@id"];
        if (lastUrl !== `${SITE}${d.route}`) {
          errs.push(`the trail ends at ${lastUrl} rather than at this page, ${SITE}${d.route}`);
        }
      }

      if (errs.length > 0) {
        crossFail(
          "breadcrumb-list",
          d.rel,
          `BreadcrumbList is malformed, so a result shows a bare URL instead of a trail:\n` +
            errs.map((e) => `        ${e}`).join("\n"),
        );
      }
    }
  }
}

/* ---- The sitemap ---- */

const sitemapFiles = (await readdir(DIST)).filter((name) => /^sitemap-\d+\.xml$/.test(name));
if (sitemapFiles.length === 0) {
  problems.push({
    rel: "sitemap-0.xml",
    id: "sitemap-missing",
    msg: "No sitemap was generated, so nothing tells a crawler these pages exist.",
  });
} else {
  const listed = new Set();
  for (const name of sitemapFiles) {
    const xml = await readFile(join(DIST, name), "utf8");
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) listed.add(match[1]);
  }

  for (const d of indexable) {
    if (!listed.has(`${SITE}${d.route}`)) {
      crossFail(
        "sitemap",
        d.rel,
        `${d.route} is indexable and is not in the sitemap. Add it, or mark the page noindex.`,
      );
    }
  }

  for (const loc of listed) {
    if (!loc.startsWith(SITE) || !routes.has(loc.slice(SITE.length))) {
      problems.push({
        rel: "sitemap-0.xml",
        id: "sitemap",
        msg: `The sitemap lists ${loc}, and no page was built there.`,
      });
    }
  }
}

/* ---- Orphans ---- */

/*
  A page nothing links to is reachable only by typing the URL. These four are
  the exceptions, and each is reached some other way rather than by a link,
  so listing them here is the honest answer and not a way of silencing the
  check. Anything else with no inbound link is a mistake.
*/
const REACHED_WITHOUT_A_LINK = new Map([
  ["/404/", "Netlify serves it for an unknown path. Nothing should link to it."],
  [
    "/cart/",
    "The header and the bottom bar link here once the store is open. While it is\n" +
      "        closed there is no cart to link to.",
  ],
  [
    "/checkout/",
    "Reached from the cart by script, after the delivery zone check passes.",
  ],
  ["/order/confirmed/", "Reached from Stripe after payment, and it is noindex."],
]);

const inbound = new Map(docs.map((d) => [d.route, new Set()]));
for (const d of docs) {
  for (const href of d.hrefs) {
    const target = routeOfHref(href);
    if (target === null) continue;
    if (!routes.has(target)) {
      crossFail(
        "dead-link",
        d.rel,
        `Links to ${href}, and no page was built at ${target}.`,
      );
      continue;
    }
    if (target !== d.route) inbound.get(target).add(d.route);
  }
}

for (const d of indexable) {
  /* The label lives on a printed tray. A QR code is its inbound link. */
  if (d.route.startsWith("/p/")) continue;
  if (REACHED_WITHOUT_A_LINK.has(d.route)) continue;
  if (inbound.get(d.route).size === 0) {
    crossFail(
      "orphan",
      d.rel,
      `Nothing on this site links to ${d.route}. A page reachable only from the sitemap\n` +
        "        is a page no customer will ever find.",
    );
  }
}

/* ------------------------------------------------------------------ */

if (pages === 0) {
  console.error(`${RED}No HTML found in dist/. Run the build first.${RST}`);
  process.exit(1);
}

console.log(`${DIM}html audit${RST} ${pages} page(s)`);

const byId = (list) => {
  const m = new Map();
  for (const item of list) {
    if (!m.has(item.id)) m.set(item.id, []);
    m.get(item.id).push(item);
  }
  return m;
};

for (const [id, items] of byId(warnings)) {
  console.log(`${YEL}  warn${RST}  ${id} ${DIM}(${items.length} page${items.length === 1 ? "" : "s"})${RST}`);
  console.log(`        ${items[0].msg}`);
  console.log(`        ${DIM}first: ${items[0].rel}${RST}`);
}

if (problems.length > 0) {
  console.error(`\n${RED}HTML audit failed.${RST} ${problems.length} problem(s) across ${byId(problems).size} check(s):\n`);
  for (const [id, items] of byId(problems)) {
    console.error(`${RED}  ✗${RST}  ${id} ${DIM}(${items.length} occurrence${items.length === 1 ? "" : "s"})${RST}`);

    /* The cross page checks each say something different, so printing one and
       counting the rest would hide most of what is wrong. Distinct messages
       are printed, up to a point. */
    const messages = [...new Set(items.map((i) => i.msg))];
    for (const msg of messages.slice(0, 5)) console.error(`        ${msg}`);
    if (messages.length > 5) {
      console.error(`        ${DIM}and ${messages.length - 5} more like it${RST}`);
    }

    const where = [...new Set(items.map((i) => i.rel))].slice(0, 6);
    console.error(`        ${DIM}in: ${where.join(", ")}${items.length > 6 ? " and more" : ""}${RST}\n`);
  }
  process.exit(1);
}

console.log(`${GRN}  ok${RST}    landmarks, headings, images, forms, copy and the disclosure all pass`);
console.log(
  `${GRN}  ok${RST}    ${indexable.length} indexable page(s): a title and a description of its own,\n` +
    "        a self referencing canonical, a valid trail, a place in the sitemap\n" +
    "        and a link in from somewhere\n",
);
