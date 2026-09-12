/*
  Viewport sweep. Builds, serves dist, and looks at every page in a real
  browser at every width in docs/DEVICES.md section 6.

  Why this exists rather than a unit test: the things it checks are
  properties of a rendered page, not of a source file. A component can be
  correct on its own and still overflow when it sits next to another one, and
  the widths that break are never the widths anybody opens by hand. The one
  layout bug that survived every other audit in this project was found by
  taking a screenshot at 390px and looking at it, so this takes the screenshot
  at twenty six widths and reads the numbers back.

  What fails a run:

    1. Horizontal overflow. The document scrolls sideways, or an element
       reaches past the right hand edge with no scroll container of its own.
    2. An interactive element smaller than 44 by 44 CSS pixels. WCAG 2.2
       target size, with the standard exception for a link inside a sentence.
    3. A form control whose computed font size is under 16px. iOS Safari
       zooms the page on focus if it is even one pixel under, and does not
       zoom back out.
    4. Text clipped by its own container: the content is wider or taller than
       the box and the box hides the remainder.
    5. Text wider than the box holding it, with nothing clipping and nothing
       scrolling. Number 4 needs a box that hides its own overflow. This is
       the other half: a value column squeezed to a sliver spills its words
       out sideways in plain sight, the document never scrolls, and every
       other check passes. That is how an allergen list one word per line
       came through a clean run.
    6. Text cut off by an ANCESTOR that clips. A card with overflow: clip can
       cut the end of a line inside it while the box holding that line clips
       nothing at all, so neither 4 nor 5 sees it.

  EVERY WIDTH IS SWEPT AT TWO TEXT SIZES, and the second one is not a
  formality. The browser default font size is a setting people really change,
  every length on this site that matters is in rem, and the six bands in
  breakpoints.css are written in rem as well, so turning it up moves the
  layout as much as turning the phone sideways does. Nothing in the list
  above showed at 16px and then failed at 24px by a small margin: the things
  it caught were a hero photograph 8px off the right hand edge, an order bar
  reading "Not taking ..." where the page says the store is shut, a footer
  40px wider than a Galaxy Fold, and a bottom bar reading "Ho... Sh... G...".
  24px is Chromium's largest preset, which is what a reader actually has a
  button for.

  Every finding names the width, the text size, the page and the element.

  Usage:
    node scripts/check-viewports.mjs              build first, then sweep
    node scripts/check-viewports.mjs --no-build   sweep the dist that is there
    node scripts/check-viewports.mjs --width=466  one viewport
    node scripts/check-viewports.mjs --text=24    one text size
    node scripts/check-viewports.mjs --page=/gata/
    node scripts/check-viewports.mjs --json

  The width list is read out of docs/DEVICES.md rather than repeated here, so
  the document really is the source of truth. Adding a device to that table is
  the only thing anybody has to do when a new phone lands.
*/

import { readdir, readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, relative, extname } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const DEVICES_DOC = join(ROOT, "docs", "DEVICES.md");

const RED = "\x1b[31m", GRN = "\x1b[32m";
const DIM = "\x1b[2m", RST = "\x1b[0m", BLD = "\x1b[1m";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const OPTS = {
  build: !flag("no-build"),
  onlyWidth: value("width") ? Number(value("width")) : null,
  onlyPage: value("page"),
  onlyText: value("text") ? Number(value("text")) : null,
  json: flag("json"),
  concurrency: Number(value("jobs") ?? 4),
};

/*
  Browser default font sizes to sweep, in px. 16 is the browser default and
  the size this site is drawn at. 24 is Chromium's "Very large", the biggest
  a reader can pick without leaving the settings screen, and it is 150
  percent, so every rem on the page and every rem in a media query moves with
  it. Anything a reader can reach with a button belongs in a build gate.
*/
const TEXT_SIZES = [16, 24];

/* ------------------------------------------------------------------ */
/* The matrix, read out of docs/DEVICES.md                             */
/* ------------------------------------------------------------------ */

/*
  Heights for the widths that are not a device in the tables. These are band
  probes rather than hardware: a width chosen to sit inside a breakpoint band,
  paired with a height that is ordinary for a screen that wide. Anything with
  a real device behind it takes its height from the table instead.
*/
const PROBE_HEIGHTS = {
  320: 568,
  520: 900,
  768: 1024,
  1180: 820,
  1280: 800,
  1440: 900,
  1920: 1080,
};

/*
  Two extra entries, both landscape, both deliberate. Section 6 lists portrait
  widths, and the shape rules in src/styles/breakpoints.css are the half of
  the system that a portrait sweep cannot exercise at all. A phone turned on
  its side is the same problem as the Duo folded: plenty of width, almost no
  height.
*/
const SHAPE_PROBES = [
  { width: 844, height: 390, label: "iPhone 13 to 16, landscape" },
  { width: 678, height: 466, label: "iPhone Duo folded, landscape" },
];

async function readMatrix() {
  const doc = await readFile(DEVICES_DOC, "utf8");

  /* Every "466 x 678" in the device tables, with the device name beside it. */
  const devices = new Map();
  for (const line of doc.split("\n")) {
    /* Rows are markdown, so a cell can carry bold markers and a tilde for an
       approximate figure. Both are noise here. */
    const row = line.match(/^\|\s*(.+?)\s*\|\s*\**~?\s*(\d{3,4})\s*x\s*(\d{3,4})\s*\**\s*\|/);
    if (!row) continue;
    const [, rawName, w, h] = row;
    const name = rawName.replaceAll("*", "").trim();
    const width = Number(w);
    if (!devices.has(width)) devices.set(width, { height: Number(h), label: name });
  }

  const sweep = doc.match(/Widths swept:\s*([\d,\s]+?)\./);
  if (!sweep) {
    throw new Error(
      "docs/DEVICES.md has no 'Widths swept:' line. That line is the sweep, so " +
        "this script cannot run without it.",
    );
  }

  const widths = sweep[1]
    .split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (widths.length === 0) throw new Error("The 'Widths swept:' line in docs/DEVICES.md is empty.");

  const viewports = widths.map((width) => {
    const device = devices.get(width);
    if (device) return { width, height: device.height, label: device.label };
    const probe = PROBE_HEIGHTS[width];
    if (probe) return { width, height: probe, label: "band probe" };
    throw new Error(
      `Width ${width} is swept by docs/DEVICES.md but has no height: it is in no ` +
        "device table, and PROBE_HEIGHTS in this script does not cover it. Add it " +
        "to one of the two.",
    );
  });

  return [...viewports, ...SHAPE_PROBES].sort((a, b) => a.width - b.width || a.height - b.height);
}

/* ------------------------------------------------------------------ */
/* Build and serve                                                     */
/* ------------------------------------------------------------------ */

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** A static server for dist, with the directory style URLs the site builds. */
function serve(dir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path.includes("..")) {
      res.writeHead(400).end("no");
      return;
    }
    const candidates = path.endsWith("/")
      ? [join(dir, path, "index.html")]
      : [join(dir, path), join(dir, `${path}.html`), join(dir, path, "index.html")];

    const file = candidates.find((c) => existsSync(c) && !c.endsWith("/"));
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    /*
      The stream needs its own error handler or a file that goes missing
      between the existsSync above and the open below takes the whole run
      down with an unhandled 'error' event, and the sweep reports nothing at
      all rather than the pages it had already measured.

      That gap is not theoretical. Every asset in dist is content hashed, so
      a build running in another terminal renames all of them, and a request
      already in flight for the old name finds nothing. Dropping the one
      response is the right answer: the page then renders without that font
      or that photograph, which the audit will notice on its own if it
      matters.
    */
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Every built page, as the route a visitor would open. */
async function routes(dir) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".html")) {
        const rel = relative(dir, full).split(/[\\/]/).join("/");
        /* The site builds directory style URLs, so /shop/gata/index.html is
           served at /shop/gata/. 404.html is the one file served by name. */
        if (rel === "index.html") found.push("/");
        else if (rel.endsWith("/index.html")) found.push(`/${rel.slice(0, -"index.html".length)}`);
        else found.push(`/${rel}`);
      }
    }
  }
  await walk(dir);
  return found.sort();
}

/* ------------------------------------------------------------------ */
/* The audit, run inside the page                                      */
/* ------------------------------------------------------------------ */

/*
  Written as one function so it can be handed to page.evaluate whole. It runs
  in the browser, so it cannot see anything in this file.
*/
function auditPage() {
  const vw = document.documentElement.clientWidth;
  const findings = [];
  const add = (kind, el, detail) => findings.push({ kind, el: describe(el), detail });

  function describe(el) {
    if (!el) return "(document)";
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 42);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ""}`;
  }

  const style = (el) => getComputedStyle(el);
  const rendered = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = style(el);
    return s.display !== "none" && s.visibility !== "hidden";
  };

  /*
    Anything deliberately out of the way: screen reader only text, the skip
    link waiting above the top edge, and the spam honeypot, which is parked
    off the left edge on purpose because a robot skips a field that is not
    rendered. None of these is a layout fault and none of them is a target.
  */
  const parked = (el) => {
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert")) return true;
      const s = style(node);
      if (s.clipPath === "inset(50%)") return true;
      if (s.position === "absolute" || s.position === "fixed") {
        const r = node.getBoundingClientRect();
        /* Taken out of flow and put somewhere nobody is: above the top edge,
           which is where the skip link waits, or off the left edge, which is
           where the honeypot lives. Measured rather than read off the
           transform, because a rotation is not a hiding place. */
        if (r.bottom <= 0 || r.right <= 0) return true;
        /* Or shrunk to a pixel and clipping whatever is inside it. */
        if (r.width <= 1 && r.height <= 1 && s.overflow !== "visible") return true;
      }
    }
    return false;
  };

  const all = [...document.body.querySelectorAll("*")];

  /* ---- 1. Horizontal overflow ------------------------------------- */

  if (document.documentElement.scrollWidth > vw + 1) {
    findings.push({
      kind: "overflow",
      el: "(document)",
      detail: `document scrollWidth ${document.documentElement.scrollWidth} against viewport ${vw}`,
    });
  }

  /* A real scroll container is allowed to be wider than the screen, because
     it moves its own content and not the page. Anything else is not. */
  const scrollsItself = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const ox = style(node).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };

  const overflowing = new Set();
  for (const el of all) {
    if (!rendered(el) || parked(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (scrollsItself(el)) continue;
      overflowing.add(el);
    }
  }

  /*
    One overflowing block drags every child out with it, and a report that
    names forty elements names none of them. Only the outermost box in each
    run is reported: that is the one holding the width, and fixing it fixes
    the rest. A child that overflows a parent which does not is still its
    own finding, which is the long unbreakable string case.
  */
  for (const el of overflowing) {
    if (el.parentElement && overflowing.has(el.parentElement)) continue;
    const r = el.getBoundingClientRect();
    add(
      "overflow",
      el,
      `spans ${Math.round(r.left)} to ${Math.round(r.right)} against a ${vw}px viewport`,
    );
  }

  /* ---- 2. Target size, WCAG 2.2 2.5.8 ------------------------------ */

  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
    '[tabindex]:not([tabindex="-1"])';

  /*
    WCAG 2.2 target size carries an inline exception, and it is not a loophole:
    a link set in running text is sized by the type scale, and growing it to
    44px would push the words of the sentence apart. A link inside a nav is
    not that. It is a control that happens to be made of letters, so it is
    held to the full size whatever its text measures.
  */
  const TEXT_FLOW = new Set(["P", "LI", "DD", "DT", "H1", "H2", "H3", "H4", "H5", "H6",
    "SPAN", "STRONG", "EM", "FIGCAPTION", "BLOCKQUOTE", "TD", "TH", "LABEL", "SUMMARY"]);

  const isTextLink = (el) => {
    if (el.tagName !== "A") return false;
    if (el.closest("nav, [role='navigation']")) return false;
    if (el.getAttribute("role") === "button") return false;
    const s = style(el);
    /* Button chrome: a filled or outlined box is a control, not a phrase. */
    const filled = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent";
    const bordered = Number.parseFloat(s.borderTopWidth) > 0;
    const padded = Number.parseFloat(s.paddingTop) >= 8 || Number.parseFloat(s.paddingLeft) >= 8;
    if (filled || bordered || padded) return false;
    /* Either it is inline, or it is a flex item whose parent is a block of
       text: both are the same phrase set in the same line of type. */
    if (s.display === "inline" || s.display === "contents") return true;
    return TEXT_FLOW.has(el.parentElement?.tagName ?? "");
  };

  /*
    A checkbox is 24px of box and a sentence of label, and clicking the label
    works the control. The target the finger actually has is the two of them
    together, so that is what gets measured.
  */
  const targetBox = (el) => {
    const r = el.getBoundingClientRect();
    const labels = el.labels ? [...el.labels] : [];
    const wrapper = el.closest("label");
    if (wrapper && !labels.includes(wrapper)) labels.push(wrapper);
    let box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    for (const label of labels) {
      if (!rendered(label)) continue;
      const lr = label.getBoundingClientRect();
      box = {
        left: Math.min(box.left, lr.left),
        right: Math.max(box.right, lr.right),
        top: Math.min(box.top, lr.top),
        bottom: Math.max(box.bottom, lr.bottom),
      };
    }
    return { width: box.right - box.left, height: box.bottom - box.top, labelled: labels.length > 0 };
  };

  for (const el of document.body.querySelectorAll(INTERACTIVE)) {
    if (!rendered(el) || parked(el)) continue;
    if (el.disabled) continue;
    if (isTextLink(el)) continue;

    const box = targetBox(el);
    if (box.width < 43.5 || box.height < 43.5) {
      add(
        "target",
        el,
        `${box.width.toFixed(0)} by ${box.height.toFixed(0)}, needs 44 by 44` +
          (box.labelled ? " (measured with its label)" : ""),
      );
    }
  }

  /* ---- 3. Form control type size ----------------------------------- */

  for (const el of document.body.querySelectorAll("input, select, textarea")) {
    if (el.type === "hidden" || !rendered(el) || parked(el)) continue;
    const size = Number.parseFloat(style(el).fontSize);
    if (size < 15.99) {
      add("font", el, `computed font size ${size.toFixed(1)}px, iOS zooms under 16px`);
    }
  }

  /* ---- 4. Text clipped by its container ---------------------------- */

  const hasOwnText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);

  for (const el of all) {
    if (!rendered(el) || parked(el) || !hasOwnText(el)) continue;
    const s = style(el);
    const clipsX = s.overflowX === "hidden" || s.overflowX === "clip";
    const clipsY = s.overflowY === "hidden" || s.overflowY === "clip";
    if (!clipsX && !clipsY) continue;
    if (clipsX && el.scrollWidth > el.clientWidth + 1) {
      add("clipped", el, `text is ${el.scrollWidth}px wide inside a ${el.clientWidth}px box`);
    } else if (clipsY && el.scrollHeight > el.clientHeight + 1) {
      add("clipped", el, `text is ${el.scrollHeight}px tall inside a ${el.clientHeight}px box`);
    }
  }

  /* ---- 5. Text wider than the box holding it ------------------------ */

  /*
    Nothing has to clip for a line to be ruined. A label column stated in rem
    beside a value column of whatever is left is fine at the size it was
    drawn and cruel one setting up: at 24px browser text on a 344px screen
    the product card's 6.5rem label took 156 of the 246px row and left 72 for
    the value, so the six allergens came out one word per line with "Almonds,"
    hanging 21px into the card's padding. The document did not scroll, no box
    clipped anything, and every other check on this page passed.

    Block level only, and a 2px tolerance, because an inline box reports
    scrollWidth in ways that are not worth arguing with. Anything that
    genuinely wants to be wider than its box has a scroll container or a clip,
    and both are handled above.
  */
  for (const el of all) {
    if (!rendered(el) || parked(el) || !hasOwnText(el)) continue;
    if ([...el.children].some((child) => hasOwnText(child))) continue;
    const s = style(el);
    if (s.display === "inline" || s.display === "contents") continue;
    if (s.overflowX !== "visible") continue;
    if (el.scrollWidth > el.clientWidth + 2) {
      add("spill", el, `content is ${el.scrollWidth}px wide in a ${el.clientWidth}px box`);
    }
  }

  /* ---- 6. Text cut off by an ancestor that clips -------------------- */

  /*
    The overflow check forgives anything inside a scroll container, and it is
    right to: a container that scrolls moves its own content and loses none
    of it. `hidden` and `clip` are not that. They cut, silently, and the
    document never scrolls sideways to say so, so a line can lose its last
    word inside a card while every other check on this page passes.

    Only the innermost element carrying the text is measured, against the
    padding box of the nearest ancestor that clips rather than scrolls.
  */
  const clippingAncestor = (el) => {
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const s = style(node);
      /* A real scroll container reached first means nothing above it can
         cut this text: the scrolling one owns the overflow. */
      if (s.overflowX === "auto" || s.overflowX === "scroll") return null;
      if (s.overflowY === "auto" || s.overflowY === "scroll") return null;
      if (s.overflowX === "hidden" || s.overflowX === "clip") return node;
    }
    return null;
  };

  for (const el of all) {
    if (!rendered(el) || parked(el) || !hasOwnText(el)) continue;
    /* The element that holds the words, not every block above it. */
    if ([...el.children].some((child) => hasOwnText(child))) continue;
    const box = clippingAncestor(el);
    /* body carries overflow-x: clip site wide, which is the backstop that
       stops a sideways scroll rather than a box cutting a word in half. */
    if (!box || box === document.body) continue;
    const boxStyle = style(box);
    const boxRect = box.getBoundingClientRect();
    const left = boxRect.left + Number.parseFloat(boxStyle.borderLeftWidth || "0");
    const right = boxRect.right - Number.parseFloat(boxStyle.borderRightWidth || "0");
    const r = el.getBoundingClientRect();
    if (r.right > right + 1 || r.left < left - 1) {
      add(
        "cutoff",
        el,
        `runs ${Math.round(r.left)} to ${Math.round(r.right)} inside a ${describe(box)} ` +
          `that cuts at ${Math.round(left)} to ${Math.round(right)}`,
      );
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

const KIND_LABEL = {
  overflow: "horizontal overflow",
  target: "tap target under 44 by 44",
  font: "form control under 16px",
  clipped: "clipped text",
  spill: "text wider than its box",
  cutoff: "text cut off by a box that clips",
};

async function sweep(browser, base, viewport, pages, textPx) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  /*
    The reader's browser font size, set the way the browser sets it rather
    than by writing a size onto the root element. That distinction matters:
    Chromium's default font size is what a bare `rem` resolves against AND
    what a `rem` inside a media query resolves against, so setting it here
    moves the six bands in breakpoints.css exactly as it moves them on the
    reader's phone. Writing `html { font-size }` instead would move the type
    and leave the bands where they were, which is a layout nobody has.
  */
  if (textPx !== 16) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: textPx, fixed: textPx } });
  }

  const results = [];

  for (const route of pages) {
    await page.goto(base + route, { waitUntil: "domcontentloaded" });

    /*
      Read the page the way a visitor does before measuring it. Scrolling to
      the bottom and back mounts anything waiting on client:visible and loads
      the lazy photographs, so the same elements exist at every width. Without
      it the result depends on how quickly an island happened to hydrate,
      which is not a build gate, it is a coin toss.
    */
    await page.evaluate(async () => {
      const step = Math.max(200, window.innerHeight);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => requestAnimationFrame(r));
      }
      window.scrollTo(0, 0);
    });

    /*
      Then give any React island a moment to mount, because a control that
      appears on hydration is a control that has to be measured. Astro drops
      the ssr attribute once an island is live, so this waits on the real
      signal rather than on a guess.

      The timeout is short on purpose. An island that never hydrates, which
      happens if dist is rebuilt underneath a running sweep and the hashed
      script no longer exists, would otherwise stall every page in the run.
      Measuring the page as it stands is the right answer either way.
    */
    const islands = await page.locator("astro-island[ssr]").count();
    if (islands > 0) {
      await page
        .waitForFunction(() => document.querySelectorAll("astro-island[ssr]").length === 0, null, {
          timeout: 1500,
        })
        .catch(() => {});
    }

    await page.evaluate(() => document.fonts.ready);
    const findings = await page.evaluate(auditPage);
    for (const f of findings) results.push({ route, ...f });
  }

  await context.close();
  return results;
}

/* ------------------------------------------------------------------ */

const matrix = (await readMatrix()).filter(
  (v) => OPTS.onlyWidth === null || v.width === OPTS.onlyWidth,
);

if (matrix.length === 0) {
  console.error(`No viewport in docs/DEVICES.md matches --width=${OPTS.onlyWidth}.`);
  process.exit(1);
}

const textSizes = OPTS.onlyText === null ? TEXT_SIZES : [OPTS.onlyText];

/* Every viewport at every text size, as one flat queue, so the workers stay
   busy rather than draining one text size before starting the next. */
const runs = textSizes.flatMap((textPx) => matrix.map((viewport) => ({ viewport, textPx })));

if (OPTS.build || !existsSync(join(DIST, "index.html"))) {
  console.log(`${DIM}viewports${RST} building first`);
  await run("npm", ["run", "build"]);
}

if (!existsSync(join(DIST, "index.html"))) {
  console.error(`${RED}No dist/index.html to sweep.${RST} Run npm run build.`);
  process.exit(1);
}

const pages = (await routes(DIST)).filter((r) => !OPTS.onlyPage || r === OPTS.onlyPage);
const { server, port } = await serve(DIST);
const base = `http://127.0.0.1:${port}`;

console.log(
  `${DIM}viewports${RST} ${matrix.length} viewport(s) by ${pages.length} page(s) ` +
    `at ${textSizes.map((t) => `${t}px`).join(" and ")} browser text, ` +
    `${runs.length * pages.length} renders`,
);

/*
  The proxy in this environment intercepts outbound requests, and Chromium
  hangs on its own telemetry before it ever reaches the page. Nothing here
  leaves the machine: the pages are served from a local port.
*/
for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
  delete process.env[key];
}

const launchOptions = {
  args: ["--disable-background-networking", "--no-first-run", "--no-sandbox"],
};

/* Prefer whatever Playwright installed. Fall back to a system Chromium, which
   is how this runs on a machine where only the browser is present. */
let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (error) {
  const fallback = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
  if (!existsSync(fallback)) {
    console.error(`${RED}Could not start Chromium.${RST} ${error.message}`);
    console.error(`${DIM}  Run npx playwright install chromium, or set CHROMIUM_PATH.${RST}`);
    server.close();
    process.exit(1);
  }
  browser = await chromium.launch({ ...launchOptions, executablePath: fallback });
}

const byRun = new Map();
const key = (textPx, viewport) => `${textPx}|${viewport.width}x${viewport.height}`;
const queue = [...runs];

async function worker() {
  for (;;) {
    const run = queue.shift();
    if (!run) return;
    byRun.set(key(run.textPx, run.viewport), await sweep(browser, base, run.viewport, pages, run.textPx));
  }
}

await Promise.all(
  Array.from({ length: Math.min(OPTS.concurrency, runs.length) }, () => worker()),
);

await browser.close();
server.close();

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

let failed = 0;

if (OPTS.json) {
  const payload = runs.map(({ viewport, textPx }) => ({
    ...viewport,
    textPx,
    findings: byRun.get(key(textPx, viewport)) ?? [],
  }));
  console.log(JSON.stringify(payload, null, 2));
  failed = payload.reduce((n, v) => n + v.findings.length, 0);
} else {
  let heading = null;
  for (const { viewport, textPx } of runs) {
    if (textPx !== heading) {
      heading = textPx;
      console.log(
        textPx === 16
          ? `\n${DIM}  browser text 16px, the default${RST}`
          : `\n${DIM}  browser text ${textPx}px, ${Math.round((textPx / 16) * 100)} percent of it${RST}`,
      );
    }
    const findings = byRun.get(key(textPx, viewport)) ?? [];
    failed += findings.length;
    const size = `${viewport.width} x ${viewport.height}`.padEnd(11);
    if (findings.length === 0) {
      console.log(`  ${GRN} ok ${RST} ${size} ${DIM}${viewport.label}${RST}`);
      continue;
    }
    /* The header and the footer are on every page, so one bad tap target is
       seventeen findings. Collapse them, and name the pages. */
    const grouped = new Map();
    for (const f of findings) {
      const groupKey = `${f.kind} ${f.el} ${f.detail}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, { ...f, routes: [] });
      grouped.get(groupKey).routes.push(f.route);
    }

    console.log(
      `  ${RED}FAIL${RST} ${size} ${DIM}${viewport.label}${RST}  ` +
        `${grouped.size} problem(s) over ${findings.length} page render(s)`,
    );
    for (const f of grouped.values()) {
      const where =
        f.routes.length > 3
          ? `${f.routes.slice(0, 3).join(", ")} and ${f.routes.length - 3} more`
          : f.routes.join(", ");
      console.log(`        ${BLD}${KIND_LABEL[f.kind]}${RST}  ${DIM}${where}${RST}`);
      console.log(`        ${f.el}`);
      console.log(`        ${f.detail}`);
    }
  }
}

if (failed > 0) {
  console.error(
    `\n${RED}Viewport sweep failed.${RST} ${failed} problem(s) across ` +
      `${matrix.length} viewport(s) at ${textSizes.length} text size(s).\n` +
      `${DIM}  Reproduce one with: node scripts/check-viewports.mjs --no-build ` +
      `--width=NNN --text=NN --page=/route/${RST}\n`,
  );
  process.exit(1);
}

console.log(
  `\n${GRN}  ok${RST}    ${matrix.length} viewports at ` +
    `${textSizes.map((t) => `${t}px`).join(" and ")} browser text: no overflow, ` +
    `no target under 44px, no control under 16px,\n` +
    `        no text wider than its box, clipped by it, or cut off by a box above it\n`,
);
