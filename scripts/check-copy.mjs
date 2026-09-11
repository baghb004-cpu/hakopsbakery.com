/*
  Content guard. Three jobs, run on every `npm run verify` and on commit.

  1. No em dashes, anywhere. Firm client preference, brief Section 6 and 17.
  2. No recipe. Ingredient names are legally required on the label and are
     therefore public. Quantities, ratios, timings, method and yield are the
     actual trade secret and must never enter this repository, its history,
     its comments, its alt text, or a commit message. Brief Section 4.
  3. No AI design tells in shipped copy. Brief Section 6.
  4. No banned vocabulary in shipped copy. Brief Section 17.

  Jobs 1 and 2 fail the build. Job 3 warns, because a few of its patterns
  have legitimate uses and a human should make the call.
*/

import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".astro", ".netlify", "public/fonts",
]);
const SCAN_EXT = new Set([
  ".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".md", ".css", ".json",
  ".html", ".txt", ".yml", ".yaml",
]);

/*
  Files this guard does not read: output from tools we do not control, and
  the guard itself, whose own pattern list necessarily contains the words it
  is looking for.
*/
const EXEMPT = [
  /^src\/styles\/fonts\.css$/,
  /^package-lock\.json$/,
  /^scripts\/check-copy\.mjs$/,
];

/* ------------------------------------------------------------------ */

const INGREDIENTS =
  "flour|sugar|butter|walnut|almond|cinnamon|clove|nutmeg|sour cream|" +
  "baking powder|sesame|egg|yeast|salt|vanilla|milk|cream";

const UNITS = "g|kg|gram|grams|oz|ounce|ounces|lb|lbs|tsp|tbsp|teaspoon|tablespoon|cup|cups|ml|l";

const METHOD_VERBS =
  "knead|proof|laminate|preheat|roll out|rest the dough|fold the dough|" +
  "chill the dough|cream the butter|whisk until|beat until|bake at";

/*
  Section 17 of the brief bans a short list outright. The rest of this list is
  the vocabulary that makes copy read as though a machine wrote it: words that
  describe no particular bakery and could be lifted onto any other one.

  Warnings, not failures. "Craft" has an honest trade meaning and "passion"
  can appear in a quotation, so a person makes the call. `copy-guard: allow`
  on the line silences it.
*/
const BANNED_WORDS =
  "artisanal|artisan|artisanally|crafted|craftsmanship|handcrafted|" +
  "passion|passionate|journey|nestled|elevate|elevated|elevating|delve|" +
  "tapestry|curated|bespoke|lovingly|time-honored|time-honoured|" +
  "seamless|unlock|embark|vibrant|meticulous|meticulously|indulge|" +
  "decadent|symphony|medley|savor the|savour the";

/* The same tell at sentence length rather than word length. */
const BANNED_CONSTRUCTIONS =
  /\b(?:not just [a-z]+,? but|more than just|whether you(?:'re| are)\b[^.\n]{0,60}\bor\b|in today's|a testament to|at the heart of)/gi;

/*
  Rules tagged `only` run on shipped copy rather than on the whole tree. A
  security comment about "a crafted request" is not a marketing cliche, and
  neither is `!==` in a test.
*/
const COPY_FILES = /^src\/(?:pages|components|layouts|islands|content|config)\//;

const HARD = [
  {
    id: "em-dash",
    re: /[—―]/g,
    msg: "Em dash. Use a comma, a colon, parentheses, or two sentences.",
  },
  {
    id: "recipe-quantity",
    // An ingredient name sitting within a short distance of a number + unit.
    re: new RegExp(
      `(?:(?:${INGREDIENTS})[^\\n]{0,40}?\\b\\d[\\d.,/]*\\s*(?:${UNITS})\\b)` +
        `|(?:\\b\\d[\\d.,/]*\\s*(?:${UNITS})\\b[^\\n]{0,40}?(?:${INGREDIENTS}))`,
      "gi",
    ),
    msg:
      "An ingredient next to a quantity. The recipe must never enter this\n" +
      "        repository. Ingredient NAMES are fine and legally required. Amounts\n" +
      "        are not. If this is a package net weight, tag the line with\n" +
      "        `netWeight` or add `// copy-guard: net-weight` and re-run.",
  },
  {
    id: "recipe-method",
    re: new RegExp(`\\b(?:${METHOD_VERBS})\\b`, "gi"),
    msg: "Recipe method language. Technique stays out of the repository.",
  },
  {
    id: "oven-spec",
    re: /\b\d{3}\s*(?:°\s*)?(?:f|c|degrees)\b[^\n]{0,30}\b\d+\s*(?:min|minutes|hours?)\b/gi,
    msg: "An oven temperature next to a time. That is the recipe.",
  },
];

const SOFT = [
  {
    id: "ai-tell-arrow",
    re: /(?:>|"|'|\s)(?:Shop|Order|Buy|Learn more|Read more|Get started|View)[^<"'\n]{0,18}(?:→|->|&rarr;|&#8594;)/gi,
    msg: "Arrow appended to button text. Listed as an AI tell in the brief.",
  },
  {
    id: "ai-tell-middot",
    re: /\w\s+·\s+\w[^\n]{0,40}·\s+\w/g,
    msg: "Meta string joined with middle dots. Listed as an AI tell.",
  },
  {
    id: "ai-tell-eyebrow",
    re: /class="[^"]*\b(?:uppercase|tracking-(?:wide|wider|widest))\b[^"]*"/g,
    msg:
      "All caps or tracked out text. If this is an eyebrow label above a\n" +
      "        heading, the brief says remove it.",
  },
  {
    id: "ai-tell-numbered",
    re: />\s*0[1-9]\s*(?:\/|of)\s*0[1-9]\s*</g,
    msg: "01 / 02 / 03 markers. Only acceptable on a genuine sequence.",
  },
  {
    id: "ai-tell-cliche-palette",
    re: /#(?:F4F1EA|f4f1ea|D97757|d97757)\b/g,
    msg: "The cream and terracotta combination the brief names as the 2026 tell.",
  },
  {
    id: "banned-vocabulary",
    only: COPY_FILES,
    re: new RegExp(`\\b(?:${BANNED_WORDS})\\b`, "gi"),
    msg:
      "A word from the banned list in Section 17 of the brief, or one of the\n" +
      "        machine writing tells that reads the same way. Say a concrete true\n" +
      "        thing about this bakery instead.",
  },
  {
    id: "banned-construction",
    only: COPY_FILES,
    re: BANNED_CONSTRUCTIONS,
    msg:
      "A sentence shape that could sit on any bakery's website. Brief Section\n" +
      "        17 asks for a working baker's voice. Rewrite it as something only\n" +
      "        true of this bakery.",
  },
  {
    id: "exclamation-mark",
    only: COPY_FILES,
    // A bang closing a word, which is prose. Never `!==`, `!x` or `foo!.bar`.
    re: /[A-Za-z0-9,)"']!(?=[\s"'<)]|$)/g,
    msg: "Exclamation mark. Brief Section 17 does not allow one in copy.",
  },
];

/* ------------------------------------------------------------------ */

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(rel)) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.has(extname(entry.name))) yield full;
  }
}

const RED = "\x1b[31m", YEL = "\x1b[33m", GRN = "\x1b[32m";
const DIM = "\x1b[2m", RST = "\x1b[0m";

const failures = [];
const warnings = [];
let scanned = 0;

for await (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (EXEMPT.some((g) => g.test(rel))) continue;
  const text = await readFile(file, "utf8");
  scanned += 1;
  const lines = text.split("\n");

  const run = (rules, sink) => {
    for (const rule of rules) {
      if (rule.only && !rule.only.test(rel)) continue;
      for (const [i, line] of lines.entries()) {
        // Per line opt out, for the rare legitimate case.
        if (line.includes("copy-guard: allow") || line.includes("copy-guard: net-weight")) continue;
        if (/\bnetWeight\b/.test(line) && rule.id === "recipe-quantity") continue;
        rule.re.lastIndex = 0;
        const m = rule.re.exec(line);
        if (m) sink.push({ rel, line: i + 1, rule, found: m[0].trim().slice(0, 60) });
      }
    }
  };

  run(HARD, failures);
  run(SOFT, warnings);
}

console.log(`${DIM}copy guard${RST} scanned ${scanned} files`);

for (const w of warnings) {
  console.log(`${YEL}  warn${RST}  ${w.rel}:${w.line}  ${DIM}${w.rule.id}${RST}`);
  console.log(`        ${w.rule.msg}`);
  console.log(`        ${DIM}found: ${JSON.stringify(w.found)}${RST}`);
}

if (failures.length > 0) {
  console.error(`\n${RED}Content guard failed.${RST} ${failures.length} blocking issue(s):\n`);
  for (const f of failures) {
    console.error(`${RED}  ✗${RST}  ${f.rel}:${f.line}  ${DIM}${f.rule.id}${RST}`);
    console.error(`        ${f.rule.msg}`);
    console.error(`        ${DIM}found: ${JSON.stringify(f.found)}${RST}\n`);
  }
  process.exit(1);
}

console.log(
  `${GRN}  ok${RST}    no em dashes, no recipe, ` +
    `${warnings.length === 0 ? "no design tells" : `${warnings.length} soft warning(s)`}\n`,
);
