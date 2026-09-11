/**
 * The label text on the site is the label text in docs/COMPLIANCE.md.
 *
 * docs/COMPLIANCE.md says of itself: "If a value here disagrees with a value
 * on the site, this file is right and the site is wrong." Section 3 holds the
 * ingredient statement and the allergen statement word for word, and the site
 * renders both out of src/content/products/gata.json.
 *
 * Nothing was checking that those two agreed. They did agree, and an
 * allergen list that quietly stops agreeing with the printed label is the
 * single worst thing this repository could ship, so the agreement is asserted
 * here rather than left to whoever remembers to open both files.
 *
 * This reads the document, not a copy of the document. A test that retyped
 * the ingredient list would only prove that somebody retyped it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const doc = read("../docs/COMPLIANCE.md");
const product = JSON.parse(read("../src/content/products/gata.json")) as {
  name: string;
  ingredients: string[];
  allergens: string[];
};

/**
 * Pull one fenced block out of the document by the text that introduces it.
 * The fences in section 3 are plain, so the first one after the heading is
 * the one wanted.
 */
function fencedBlockAfter(heading: string): string {
  const at = doc.indexOf(heading);
  expect(at, `docs/COMPLIANCE.md has no "${heading}" heading`).toBeGreaterThan(-1);
  const open = doc.indexOf("```", at);
  const close = doc.indexOf("```", open + 3);
  expect(open, "no fenced block after " + heading).toBeGreaterThan(-1);
  expect(close, "unclosed fenced block after " + heading).toBeGreaterThan(open);
  return doc.slice(open + 3, close).trim();
}

/** A fenced block is wrapped for the page width. Unwrap it to one line. */
const oneLine = (block: string): string => block.replace(/\s+/g, " ").trim();

describe("the label text in docs/COMPLIANCE.md is the label text on the site", () => {
  it("uses the same product common name", () => {
    expect(product.name).toBe(fencedBlockAfter("### Product common name"));
  });

  it("lists the same ingredients, in the same order", () => {
    const stated = oneLine(fencedBlockAfter("### Ingredient statement"));
    expect(stated.startsWith("INGREDIENTS: ")).toBe(true);

    const fromDoc = stated
      .slice("INGREDIENTS: ".length)
      .replace(/\.$/, "")
      .split(",")
      .map((name) => name.trim());

    expect(product.ingredients).toEqual(fromDoc);
  });

  it("declares the same allergens, in the same order", () => {
    const stated = oneLine(fencedBlockAfter("### Allergen statement"));
    expect(stated.startsWith("CONTAINS: ")).toBe(true);

    const fromDoc = stated
      .slice("CONTAINS: ".length)
      .replace(/\.$/, "")
      .split(",")
      .map((name) => name.trim());

    expect(product.allergens).toEqual(fromDoc);
  });

  it("keeps sesame on the list, which is the one a stale template drops", () => {
    expect(product.allergens).toContain("Sesame");
  });

  it("names every allergen bearing ingredient that is actually in the list", () => {
    /*
      Not a substitute for reading the label. It catches the specific way this
      list goes wrong: an ingredient is added or renamed and the CONTAINS line
      is not revisited. Milk is here because butter and sour cream are dairy
      and neither word contains "milk".
    */
    const ingredients = product.ingredients.join(", ").toLowerCase();
    const implied: ReadonlyArray<readonly [RegExp, string]> = [
      [/\bflour\b/, "Wheat"],
      [/\b(butter|sour cream|cream|milk)\b/, "Milk"],
      [/\begg\b/, "Egg"],
      [/\balmond/, "Almonds"],
      [/\bwalnut/, "Walnuts"],
      [/\bsesame\b/, "Sesame"],
    ];
    for (const [pattern, allergen] of implied) {
      if (pattern.test(ingredients)) {
        expect(product.allergens, `${allergen} is in the ingredients`).toContain(allergen);
      }
    }
  });

  it("carries no quantity beside any ingredient name", () => {
    /*
      Ingredient names are public and required. Amounts are the recipe. A
      name that arrived with a number attached would be printed on the page
      and on the label, so it is refused here as well as by check-copy.
    */
    for (const name of product.ingredients) {
      expect(name, `"${name}" carries a number`).not.toMatch(/\d/);
    }
  });
});
