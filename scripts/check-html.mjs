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

const DIST = join(process.cwd(), "dist");

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

const problems = [];
const warnings = [];
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
    console.error(`        ${items[0].msg}`);
    const where = [...new Set(items.map((i) => i.rel))].slice(0, 6);
    console.error(`        ${DIM}in: ${where.join(", ")}${items.length > 6 ? " and more" : ""}${RST}\n`);
  }
  process.exit(1);
}

console.log(`${GRN}  ok${RST}    landmarks, headings, images, forms, copy and the disclosure all pass\n`);
