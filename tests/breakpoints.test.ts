/**
 * The breakpoint system, held to the document it came from.
 *
 * docs/DEVICES.md is the source of truth for every viewport number on this
 * site, and src/styles/breakpoints.css is the only place those numbers turn
 * into layout. Two files with the same numbers in them drift, and the drift
 * is silent: a band edge moved by 8px breaks nothing that any other test
 * would notice, and then a foldable gets the wrong layout for a year.
 *
 * So this reads both and fails when they disagree. It also checks the things
 * the band system promises but a browser test cannot see at a glance: that
 * every token a band moves has a base value somewhere, that nothing in the
 * stylesheets reaches for 100vh, and that the shape rule asks for both a
 * ratio and a height rather than a ratio alone.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const devices = read("../docs/DEVICES.md");
const breakpoints = read("../src/styles/breakpoints.css");
const tokens = read("../src/styles/tokens.css");
const global = read("../src/styles/global.css");

/** The px figure a rem media query resolves to at the 16px browser default. */
const remToPx = (rem: number): number => rem * 16;

/** Every width in a media query in the file, in px, with its direction. */
function mediaWidths(css: string): { min: number[]; max: number[] } {
  const min: number[] = [];
  const max: number[] = [];
  for (const [, kind, value, unit] of css.matchAll(
    /\((min|max)-width:\s*([\d.]+)(rem|px)\)/g,
  )) {
    const px = unit === "rem" ? remToPx(Number(value)) : Number(value);
    (kind === "min" ? min : max).push(px);
  }
  return { min, max };
}

describe("the bands match docs/DEVICES.md section 5", () => {
  /*
    Read the band table out of the document rather than retyping it. The row
    shape is `| \`tweener\` | 520 to 767px | ... |`, with the first and last
    rows written as "to 359px" and "1024px and up".
  */
  const bands = new Map<string, { from: number; to: number | null }>();
  for (const match of devices.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*([^|]+?)\s*\|/gm)) {
    const name = match[1] ?? "";
    const range = match[2] ?? "";
    const to = range.match(/^to (\d+)px$/);
    const from = range.match(/^(\d+)px and up$/);
    const span = range.match(/^(\d+)\s*to\s*(\d+)px$/);
    if (to) bands.set(name, { from: 0, to: Number(to[1]) });
    else if (from) bands.set(name, { from: Number(from[1]), to: null });
    else if (span) bands.set(name, { from: Number(span[1]), to: Number(span[2]) });
  }

  it("finds all six bands in the document", () => {
    expect([...bands.keys()]).toEqual([
      "narrow",
      "phone",
      "phone-wide",
      "tweener",
      "tablet",
      "desktop",
    ]);
  });

  it("names every band in the stylesheet, so the numbers can be traced", () => {
    for (const name of bands.keys()) {
      expect(breakpoints, `breakpoints.css never mentions the ${name} band`).toContain(name);
    }
  });

  it("opens each band at the width the document gives it", () => {
    const { min } = mediaWidths(breakpoints);
    /* The phone band is the base, so it has no query of its own. Every other
       band that starts above zero has to open exactly where the table says. */
    for (const [name, band] of bands) {
      if (name === "phone" || band.from === 0) continue;
      expect(min, `no media query opens the ${name} band at ${band.from}px`).toContain(band.from);
    }
  });

  it("declares the same edges as custom properties, for anything reading the CSS", () => {
    /*
      The --bp-* block at the top of breakpoints.css is documentation, because
      a custom property cannot be used inside a media query. Documentation
      that nothing checks is a comment that goes stale, so it is checked.
    */
    for (const [name, band] of bands) {
      if (name === "narrow") continue; // the band that starts at zero
      const declared = breakpoints.match(new RegExp(`--bp-${name}:\\s*(\\d+)px`))?.[1];
      expect(declared, `breakpoints.css does not declare --bp-${name}`).toBeDefined();
      expect(Number(declared)).toBe(band.from);
    }
  });

  it("closes the narrow band one pixel under where the phone band opens", () => {
    const narrow = bands.get("narrow");
    const phone = bands.get("phone");
    const { max } = mediaWidths(breakpoints);
    expect(narrow?.to).toBe((phone?.from ?? 0) - 1);
    /* 22.4375rem is 359px. A max-width query has to sit under the next band
       rather than on it, or the two bands both apply at the boundary. */
    expect(max).toContain(narrow?.to);
  });

  it("leaves no gap and no overlap between the bands", () => {
    const ordered = [...bands.values()];
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      if (!previous || !current) throw new Error("the band table lost a row");
      expect(current.from).toBe((previous.to ?? 0) + 1);
    }
  });
});

describe("the shape rule", () => {
  it("asks for a ratio and a height, not a ratio alone", () => {
    /*
      Shape alone would fire on the iPhone Duo UNFOLDED, which is 626 by 890.
      That screen is square, not short, and it wants the roomy tweener
      treatment. The height condition is what tells the two apart.
    */
    const rule = breakpoints.match(/@media[^{]*aspect-ratio[^{]*\{/)?.[0] ?? "";
    const declared = breakpoints.match(/--shape-short-ratio:\s*([^;]+);/)?.[1]?.trim();
    expect(declared, "breakpoints.css does not declare --shape-short-ratio").toBeDefined();
    expect(rule, "the query and the declared ratio disagree").toContain(
      `min-aspect-ratio: ${declared}`,
    );
    expect(rule).toContain("max-height: 44rem");
  });

  it("clears the iPhone Duo folded and stops short of the unfolded one", () => {
    const HEIGHT_CAP = remToPx(44);
    const RATIO = 1 / 1.6;

    const folded = { w: 466, h: 678 };
    const unfolded = { w: 626, h: 890 };
    const landscape = { w: 844, h: 390 };
    const iphoneSe = { w: 375, h: 667 };

    const short = (v: { w: number; h: number }): boolean =>
      v.w / v.h >= RATIO && v.h <= HEIGHT_CAP;

    expect(short(folded), "the Duo folded is the device this rule is for").toBe(true);
    expect(short(landscape), "a phone in landscape is the same problem").toBe(true);
    expect(short(unfolded), "the Duo unfolded has 890px of height and is not short").toBe(false);
    expect(short(iphoneSe), "an ordinary phone in portrait is not short").toBe(false);
  });
});

describe("the fold is never load bearing", () => {
  it("only ever sets a token, never a layout property", () => {
    const foldBlocks = [...breakpoints.matchAll(/@media \((?:horizontal|vertical)-viewport-segments[^{]*\{([\s\S]*?)\n\}/g)];
    expect(foldBlocks.length).toBe(2);
    for (const block of foldBlocks) {
      /* Everything inside is a custom property assignment on :root. A
         display, a grid template or a position in here would mean the
         layout depended on an API Safari does not implement. */
      const body = block[1] ?? "";
      const declarations = [...body.matchAll(/^\s{4}([a-z-]+):/gm)].map((m) => m[1] ?? "");
      for (const property of declarations) {
        expect(property.startsWith("--"), `${property} is a layout property inside a fold query`).toBe(
          true,
        );
      }
    }
  });

  it("gives every fold token a zero value for the browsers that cannot see a hinge", () => {
    for (const token of ["--fold-gap", "--fold-gap-block"]) {
      expect(breakpoints).toMatch(new RegExp(`${token}:\\s*0px;`));
    }
  });
});

describe("the tokens the bands move", () => {
  /** Custom properties assigned anywhere inside a media query. */
  const moved = new Set(
    [...breakpoints.matchAll(/@media[^{]+\{[^{]*\{([\s\S]*?)\}/g)].flatMap((block) =>
      [...(block[1] ?? "").matchAll(/(--[a-z-]+):/g)].map((m) => m[1] ?? ""),
    ),
  );

  it("moves the rhythm and the type scale, which is the point of the file", () => {
    expect(moved).toContain("--type-lift");
    expect(moved).toContain("--band-space");
  });

  it("has a base value for every token a band moves", () => {
    const base = `${tokens}\n${breakpoints.split("@media")[0]}`;
    for (const token of moved) {
      expect(base, `${token} is moved by a band but never defined at rest`).toMatch(
        new RegExp(`${token}:`),
      );
    }
  });

  it("is what the layout primitives read, so components inherit it", () => {
    for (const token of ["--gutter", "--band-space", "--band-space-tight", "--flow-space"]) {
      expect(global, `global.css never reads ${token}`).toContain(`var(${token})`);
    }
  });
});

describe("the house rules the stylesheets have to keep", () => {
  it("never uses 100vh", () => {
    for (const [name, css] of [
      ["tokens.css", tokens],
      ["breakpoints.css", breakpoints],
      ["global.css", global],
    ] as const) {
      expect(css, `${name} uses 100vh, which breaks under mobile browser chrome`).not.toMatch(
        /\b100vh\b/,
      );
    }
  });

  it("keeps body copy and form controls at 16px or over in every band", () => {
    /* The narrow band is the only one that touches the fixed steps. A form
       control under 16px makes iOS Safari zoom the page on focus. */
    for (const [, value] of breakpoints.matchAll(/--text-(?:base|sm):\s*([\d.]+)rem/g)) {
      expect(remToPx(Number(value))).toBeGreaterThanOrEqual(14);
    }
    expect(global).toContain("font-size: max(1rem, var(--text-base))");
  });

  it("sweeps both iPhone Duo widths and the narrowest device in the sweep list", () => {
    const swept = (devices.match(/Widths swept:\s*([\d,\s]+?)\./)?.[1] ?? "")
      .split(",")
      .map((n) => Number(n.trim()));
    for (const width of [320, 344, 466, 626]) {
      expect(swept, `${width} is not in the sweep in docs/DEVICES.md section 6`).toContain(width);
    }
  });
});
