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
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TOKENS = join(process.cwd(), "src", "styles", "tokens.css");

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
  ["stitch", "sesame", "body", "links on the page"],
  ["stitch", "paper", "body", "links on a surface"],
  ["stitch", "sesame", "ui", "focus ring against the page"],
  ["stitch", "paper", "ui", "focus ring against a surface"],

  // The gold, in its two forms
  ["eggwash-ink", "sesame", "body", "gold text on the page"],
  ["eggwash-ink", "paper", "body", "gold text on a surface"],
  ["eggwash", "sesame", "decorative", "the gloss, decorative only"],

  // The single saturated accent
  ["pomegranate", "sesame", "body", "accent text on the page"],
  ["pomegranate", "paper", "body", "accent text on a surface"],

  // Inverted, as on the primary button and the skip link
  ["sesame", "crust", "body", "inverted text on the dark ink"],

  // Status colours
  ["good", "paper", "body", "success text"],
  ["warn", "paper", "body", "warning text"],
  ["bad", "paper", "body", "error text"],

  // Hairlines and borders, which are graphical objects
  ["line-strong", "paper", "ui", "input borders on a surface"],
  ["line-strong", "sesame", "ui", "input borders on the page"],

  // The cart badge
  ["paper", "pomegranate", "body", "the count on the cart badge"],
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
