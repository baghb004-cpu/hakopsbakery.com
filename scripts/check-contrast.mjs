/*
  Colour contrast, checked rather than assumed.

  The brief is specific about this: "Contrast checked, not assumed." So this
  reads the real token values out of src/styles/tokens.css, computes the true
  WCAG 2.2 contrast ratio for every pair the design actually uses, and fails
  the build if one of them is below the threshold for how it is used.

  It exists because eye judgement is unreliable on warm palettes. The gold in
  this palette looks like it ought to be readable on the page ground. It is
  not: it lands near 2.4 to 1, which fails even the relaxed threshold for
  large text. Without a check like this, someone would eventually set a
  heading in it and nobody would notice until a customer could not read it.

  There are two halves to this, and the second one is the important one.

  The first half measures the pairs listed below. On its own that is still an
  assumption: the list is written by hand, so a component that introduces a
  new colour pairing is checked only if somebody remembered to come back here
  and add it. A list that silently falls behind the code reads green and
  proves nothing.

  So the second half reads every stylesheet under src/ and pulls out the
  colours actually declared: what is used as text, what is used as a ground,
  what is used for a focus ring. Then it holds the list to that evidence. A
  token used as text with no pair covering it fails. A decorative token used
  as text or as a focus ring fails. A raw hex used as a colour is reported,
  because a pair checked here is then not the pair being shipped.
*/

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");
const TOKENS = join(SRC, "styles", "tokens.css");

/* ------------------------------------------------------------------ */
/* WCAG maths                                                          */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** Relative luminance, per the WCAG 2.x definition. */
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

/*
  WCAG 2.2 AA:
    body text            4.5 : 1
    large text           3.0 : 1   (24px, or 18.66px bold and above)
    UI components and
    graphical objects    3.0 : 1
    decorative           no requirement, and no text may sit on it
*/
const THRESHOLD = { body: 4.5, large: 3, ui: 3, decorative: 0 };

/* ------------------------------------------------------------------ */
/* The pairs this design actually uses                                 */
/* ------------------------------------------------------------------ */

/*
  Every foreground and background combination that appears in the built site.
  Adding a new colour pairing to a component means adding it here too. That is
  the point: the list is the contract.
*/
const PAIRS = [
  // Body copy on the two page grounds
  ["crust", "sesame", "body", "primary text on the page"],
  ["crust", "paper", "body", "primary text on a raised surface"],
  ["crust-soft", "sesame", "body", "secondary text on the page"],
  ["crust-soft", "paper", "body", "secondary text on a surface"],

  // Links and focus
  ["link", "sesame", "body", "links on the page"],
  ["link", "paper", "body", "links on a surface"],
  ["link", "sesame", "ui", "focus ring against the page"],
  ["link", "paper", "ui", "focus ring against a surface"],

  // The gold, in its two forms
  ["eggwash-ink", "sesame", "body", "gold text on the page"],
  ["eggwash-ink", "paper", "body", "gold text on a surface"],
  ["eggwash", "sesame", "decorative", "the gloss, decorative only"],

  // The single saturated accent

  // The hover colour. It is a text colour on every link on the site, so it
  // is held to the text threshold and not waved through as a hover.
  ["link-bright", "sesame", "body", "a link under the pointer, on the page"],
  ["link-bright", "paper", "body", "a link under the pointer, on a surface"],

  // The recessed ground. A selected option row and a disabled input both
  // sit on it, and both carry text.
  ["crust", "sesame-deep", "body", "primary text on the recessed ground"],
  ["crust-soft", "sesame-deep", "body", "secondary text on the recessed ground"],

  // Inverted, as on the primary button and the skip link
  ["sesame", "crust", "body", "inverted text on the dark ink"],

  // Status colours. On both grounds: an island sits on the page ground, and
  // the same words inside a message block sit on paper.
  ["good", "paper", "body", "success text on a surface"],
  ["warn", "paper", "body", "warning text on a surface"],
  ["bad", "paper", "body", "error text on a surface"],
  ["good", "sesame", "body", "success text on the page"],
  ["warn", "sesame", "body", "warning text on the page"],
  ["bad", "sesame", "body", "error text on the page"],

  // Hairlines and borders, which are graphical objects
  ["line-strong", "paper", "ui", "input borders on a surface"],
  ["line-strong", "sesame", "ui", "input borders on the page"],

  // The cart badge
  ["sesame", "crust", "body", "the count on the cart badge, now ink rather than a dot"],

  // Button states, which are real pairs on the page and were literals before
  ["sesame", "crust-deep", "body", "the primary button, pressed"],
  ["crust", "paper-lift", "body", "the secondary button, hovered"],
];

/*
  Tokens that must NEVER carry text or act as a meaningful boundary, whatever
  the numbers say. The gold is here because it reads as though it should work
  and does not, and because the temptation to set a heading in it is real.
*/
const DECORATIVE_ONLY = new Set(["eggwash"]);

/* ------------------------------------------------------------------ */

const css = await readFile(TOKENS, "utf8");
const tokens = new Map();
for (const [, name, value] of css.matchAll(/--color-([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens.set(name, value);
}

const RED = "\x1b[31m", YEL = "\x1b[33m", GRN = "\x1b[32m";
const DIM = "\x1b[2m", RST = "\x1b[0m";

console.log(`${DIM}contrast${RST} ${tokens.size} colour tokens, ${PAIRS.length} pairs`);

const failures = [];
const rows = [];

for (const [fg, bg, use, label] of PAIRS) {
  const fgHex = tokens.get(fg);
  const bgHex = tokens.get(bg);

  if (!fgHex || !bgHex) {
    failures.push(`Unknown token in pair: ${!fgHex ? fg : bg}. Did a token get renamed?`);
    continue;
  }

  const r = ratio(fgHex, bgHex);
  const need = THRESHOLD[use];
  const pass = r >= need;

  rows.push({ fg, bg, use, label, r, need, pass });

  if (!pass && use !== "decorative") {
    failures.push(
      `${fg} on ${bg} is ${r.toFixed(2)} to 1, below the ${need} to 1 needed for ${use}.\n` +
        `        Used for: ${label}`,
    );
  }
}

// Sort worst first, so the tightest pairs are visible at a glance.
for (const row of [...rows].sort((a, b) => a.r - b.r)) {
  const mark = row.use === "decorative" ? `${DIM}dec ${RST}` : row.pass ? `${GRN} ok ${RST}` : `${RED}FAIL${RST}`;
  const note = row.use === "decorative" ? `${DIM}(no text may sit on this)${RST}` : "";
  console.log(
    `  ${mark} ${row.r.toFixed(2).padStart(5)} : 1  ` +
      `${DIM}need ${String(row.need).padEnd(3)}${RST} ` +
      `${row.fg} on ${row.bg}  ${DIM}${row.label}${RST} ${note}`,
  );
}

/* ------------------------------------------------------------------ */
/* What the source actually declares                                   */
/* ------------------------------------------------------------------ */

/*
  Walk src/ and read every colour declaration out of the stylesheets and the
  scoped <style> blocks. This is deliberately textual rather than a real CSS
  parse: it needs to know which tokens are named in which kind of property,
  and for that a regex over the declaration is both enough and impossible to
  get wrong in a way that quietly passes.
*/

const STYLE_FILES = /\.(css|astro|tsx)$/;

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (STYLE_FILES.test(entry.name)) yield full;
  }
}

/* Properties that put a colour behind text, on text, or around a control. */
const TEXT_PROPS = /(?:^|[^-\w])(color|-webkit-text-fill-color|text-decoration-color)\s*:\s*([^;{}]+)/g;
const GROUND_PROPS = /(?:^|[^-\w])(background|background-color)\s*:\s*([^;{}]+)/g;
const RING_PROPS = /(?:^|[^-\w])(outline|outline-color|caret-color)\s*:\s*([^;{}]+)/g;

/** Every --color-* token named in a declaration value. */
function tokensIn(value) {
  return [...value.matchAll(/var\(\s*--color-([\w-]+)/g)].map((m) => m[1]);
}

/** A literal hex used as a colour. Masks and gradients are not colour pairs. */
function hexesIn(value) {
  if (/mask|gradient/.test(value)) return [];
  return [...value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
}

const usedAsText = new Map(); // token -> first "file:line"
const usedAsGround = new Map();
const usedAsRing = new Map();
const rawHex = []; // { hex, where, prop }

function record(into, name, where) {
  if (!into.has(name)) into.set(name, where);
}

for await (const file of sourceFiles(SRC)) {
  const rel = relative(process.cwd(), file);
  if (rel.endsWith(join("styles", "tokens.css"))) continue; // the definitions themselves

  const text = await readFile(file, "utf8");
  /* Line numbers, so a failure points at somewhere real. */
  const lineOf = (index) => text.slice(0, index).split("\n").length;

  for (const [bucket, pattern] of [
    [usedAsText, TEXT_PROPS],
    [usedAsGround, GROUND_PROPS],
    [usedAsRing, RING_PROPS],
  ]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const [, prop, value] = match;
      const where = `${rel}:${lineOf(match.index ?? 0)}`;
      for (const name of tokensIn(value)) record(bucket, name, where);
      for (const hex of hexesIn(value)) rawHex.push({ hex, where, prop });
    }
  }
}

const groundList = [...usedAsGround.keys()].sort();
console.log(
  `\n${DIM}usage${RST}    ${usedAsText.size} token(s) carry text, ` +
    `${usedAsGround.size} used as a ground ${DIM}(${groundList.join(", ")})${RST}`,
);

/*
  Hold the pair list to what the source does. Every token used as a text
  colour has to be covered by at least one pair, or the list has fallen
  behind the code and the green tick above means nothing.
*/
const coveredAsForeground = new Set(PAIRS.map(([fg]) => fg));

for (const [name, where] of [...usedAsText].sort()) {
  if (!tokens.has(name)) continue; // not one of ours
  if (DECORATIVE_ONLY.has(name)) {
    failures.push(
      `--color-${name} is set as a text colour at ${where}, and it is marked\n` +
        `        decorative only. It measures ${ratio(tokens.get(name), tokens.get("sesame")).toFixed(2)} to 1 on the page ground.\n` +
        "        Use --color-eggwash-ink, which is the same gold dark enough to read.",
    );
    continue;
  }
  if (!coveredAsForeground.has(name)) {
    failures.push(
      `--color-${name} is used as a text colour at ${where} but no pair in this\n` +
        "        script covers it, so its contrast has never been measured.\n" +
        "        Add it to PAIRS against the ground it actually sits on.",
    );
  }
}

/* A focus ring is a graphical object. A decorative token cannot be one. */
for (const [name, where] of [...usedAsRing].sort()) {
  if (DECORATIVE_ONLY.has(name)) {
    failures.push(
      `--color-${name} is used as a focus ring or caret at ${where}. A focus\n` +
        "        indicator has to clear 3 to 1 against its ground and this one does not.",
    );
  }
}

/*
  A raw hex is not automatically wrong, but it is a colour that this script
  cannot trace back to a token, which means the pair being shipped is not the
  pair checked above. Reported rather than failed, so it is a decision
  somebody makes rather than one the build makes for them.
*/
if (rawHex.length > 0) {
  console.log(
    `${YEL}  warn${RST}  ${rawHex.length} colour declaration(s) use a literal hex rather than a token,\n` +
      "        so the pair measured here is not the pair on the page:",
  );
  for (const { hex, where, prop } of rawHex) {
    console.log(`        ${DIM}${where}${RST} ${prop}: ${hex}`);
  }
}


/* ------------------------------------------------------------------ */
/* Colour vision deficiency                                            */
/* ------------------------------------------------------------------ */

/*
  Contrast is not the whole of colour accessibility, and treating it as though
  it is produces a specific, common bug.

  A contrast ratio compares a colour to its BACKGROUND. It says nothing about
  whether two foreground colours can be told apart from EACH OTHER. So a
  success green and an error red can both score comfortably above 4.5 to 1 on
  the same page and still be the same colour to a reader with deuteranomaly.
  That is exactly what happened here: the original tokens simulated to #57523c
  and #5a522b, a separation of 17 out of a possible 441.

  These matrices are the Machado, Oliveira and Fernandes model at full
  severity. They are an approximation, not a medical instrument, but they are
  the standard one and they are more than good enough to catch a collision of
  this size.
*/
const CVD_MATRICES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

const toLinear = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v) => {
  const c = Math.max(0, Math.min(1, v));
  return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

function simulate(hex, kind) {
  const lin = hexToRgb(hex).map(toLinear);
  const m = CVD_MATRICES[kind];
  return m.map((row) => toSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
}

/** Straight RGB distance. Crude, but the failures it catches are not subtle. */
function separation(a, b) {
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
}

/*
  Sets of colours whose whole job is to be told apart from one another.
  A minimum of 50 is the floor here: the collision this check was written for
  measured 17, and the current tokens manage 65.
*/
const MUST_DIFFER = [
  {
    id: "status",
    tokens: ["good", "warn", "bad"],
    min: 50,
    why: "success, warning and error have to be distinguishable from each other",
  },
];

console.log();
let cvdFailed = false;

for (const group of MUST_DIFFER) {
  const hexes = group.tokens.map((t) => tokens.get(t));
  if (hexes.some((h) => !h)) continue;

  const visions = ["normal", ...Object.keys(CVD_MATRICES)];
  let worst = { sep: Infinity };

  for (const vision of visions) {
    const seen = hexes.map((h) => (vision === "normal" ? hexToRgb(h) : simulate(h, vision)));
    for (let i = 0; i < seen.length; i += 1) {
      for (let j = i + 1; j < seen.length; j += 1) {
        const sep = separation(seen[i], seen[j]);
        if (sep < worst.sep) {
          worst = { sep, vision, a: group.tokens[i], b: group.tokens[j] };
        }
      }
    }
  }

  const pass = worst.sep >= group.min;
  if (!pass) cvdFailed = true;

  console.log(
    `  ${pass ? `${GRN} ok ${RST}` : `${RED}FAIL${RST}`} ` +
      `${worst.sep.toFixed(0).padStart(5)}      ${DIM}min ${group.min}${RST}  ` +
      `${group.id}: worst pair is ${worst.a} against ${worst.b} under ${worst.vision}`,
  );

  if (!pass) {
    failures.push(
      [
        `${group.id}: ${worst.a} and ${worst.b} are only ${worst.sep.toFixed(0)} apart under`,
        `        ${worst.vision}, below the ${group.min} floor. ${group.why}.`,
        "        Contrast alone will not catch this. Separate them in LIGHTNESS,",
        "        not only in hue, and make sure the component carries a word or",
        "        a mark as well as the colour. WCAG 1.4.1: never colour alone.",
      ].join("\n"),
    );
  }
}

/*
  Guard the decorative ones from drifting into a range where someone would
  reasonably assume they are usable for text.
*/
for (const name of DECORATIVE_ONLY) {
  const hex = tokens.get(name);
  if (!hex) continue;
  const onGround = ratio(hex, tokens.get("sesame") ?? "#ffffff");
  if (onGround >= THRESHOLD.body) {
    console.log(
      `\n${YEL}  note${RST}  --color-${name} now measures ${onGround.toFixed(2)} to 1 on the page\n` +
        "        ground, which passes for body text. It is still marked decorative only.\n" +
        "        If that is deliberate, move it out of DECORATIVE_ONLY in this script.",
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${RED}Contrast check failed.${RST} ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`${RED}  ✗${RST}  ${f}\n`);
  console.error(`${DIM}  Fix the token, or change how the pair is used, then run again.${RST}\n`);
  process.exit(1);
}

console.log(`\n${GRN}  ok${RST}    every pair meets WCAG 2.2 AA for how it is used\n`);
