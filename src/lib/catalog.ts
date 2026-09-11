/**
 * The product model, and the pure logic that goes with it.
 *
 * This module holds the zod schema, the TypeScript types, and every helper
 * that can answer a question about a product without reading anything else.
 * It deliberately imports nothing from `astro:content`, for two reasons.
 *
 *   1. `src/content.config.ts` imports `productSchema` from here. Keeping the
 *      content virtual module out of this file keeps that a plain import with
 *      no chance of a cycle.
 *   2. `netlify/functions/create-checkout-session.ts` has to resolve the same
 *      catalog server side, and a Netlify function cannot see `astro:content`.
 *      It can import this file and parse rows with the same schema.
 *
 * Reading the catalog lives next door, in `catalog-source.ts`.
 *
 * Section 2 of docs/ARCHITECTURE.md: the shape below is the contract. A JSON
 * file today and a Postgres row in Phase 2 both have to parse into exactly
 * this, validated by exactly this schema, or the adapter has not done its job.
 */

import { z } from "astro/zod";
import type { ImageMetadata } from "astro";
import { commerce, storeOpen } from "@config/site";

/* ------------------------------------------------------------------ */
/* Fixed vocabularies                                                  */
/* ------------------------------------------------------------------ */

/**
 * The nine major allergens, narrowed to the six that can appear in this
 * kitchen. The order is the order they are printed on the label, so do not
 * sort this array at render time. California requires the allergen statement
 * on a cottage food label and getting it wrong is the worst bug this site
 * could ship.
 */
export const ALLERGENS = [
  "Wheat",
  "Milk",
  "Egg",
  "Almonds",
  "Walnuts",
  "Sesame",
] as const;

export type Allergen = (typeof ALLERGENS)[number];

/** Weekday numbers match `Date.prototype.getDay()`. Sunday is 0. */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const IMAGE_ROLES = ["hero", "gallery", "package"] as const;
export type ImageRole = (typeof IMAGE_ROLES)[number];

/**
 * `placeholder` means nobody has agreed to this number yet and the store must
 * not present it as something you can buy. Open decision 5 in the brief.
 * Flip to `confirmed` only when Hakop has said the figure out loud.
 */
export const PRICING_STATUSES = ["placeholder", "confirmed"] as const;
export type PricingStatus = (typeof PRICING_STATUSES)[number];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKU_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/** A tray of pastry above this is a typo, not a price. */
const MAX_PRICE_CENTS = 50_000;

/** Where a locally stored photograph has to live to be resolvable. */
const PHOTO_DIR = "src/assets/photos/";

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * The voluntary nutrition panel. Optional by law for a cottage food operation
 * under the small business exemption, and null until somebody pays a lab to
 * produce real figures. Never estimate these.
 *
 * Per serving as declared on the panel. This is label data, not the recipe.
 */
export const nutritionSchema = z.strictObject({
  servingSizeGrams: z.number().int().positive(),
  servingsPerContainer: z.number().int().positive(),
  calories: z.number().int().nonnegative(),
  totalFatGrams: z.number().nonnegative(),
  saturatedFatGrams: z.number().nonnegative(),
  transFatGrams: z.number().nonnegative(),
  cholesterolMilligrams: z.number().nonnegative(),
  sodiumMilligrams: z.number().nonnegative(),
  totalCarbohydrateGrams: z.number().nonnegative(),
  dietaryFiberGrams: z.number().nonnegative(),
  totalSugarsGrams: z.number().nonnegative(),
  addedSugarsGrams: z.number().nonnegative(),
  proteinGrams: z.number().nonnegative(),
  /** ISO date of the analysis, so a stale panel is visible. */
  analysedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const productImageSchema = z.strictObject({
  /**
   * Either a repository path under `src/assets/photos/`, which the build
   * optimises, or an absolute https URL, which is what a Supabase storage
   * bucket will hand back in Phase 2. `resolveImage()` copes with both.
   */
  src: z
    .string()
    .min(1)
    .refine((v) => v.startsWith(PHOTO_DIR) || v.startsWith("https://"), {
      message:
        "An image must be a path under " +
        PHOTO_DIR +
        " or an absolute https URL.",
    }),
  /**
   * Describe the food. A screen reader user is deciding whether to buy this,
   * so "gata" alone is not alt text and "image of gata" is worse.
   */
  alt: z
    .string()
    .min(16)
    .refine((v) => !/^\s*(?:an?\s+)?(?:image|photo|photograph|picture)\s+of\b/i.test(v), {
      message:
        'Alt text must not open with "image of". Describe the food itself.',
    }),
  /** Checked against the file on disk by `resolveImage()`. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  role: z.enum(IMAGE_ROLES),
});

export const variantSchema = z.strictObject({
  /** Stable. The cart stores this string, so renaming one orphans a cart. */
  id: z.string().regex(SLUG_RE, "A variant id is lower case and hyphenated."),
  /** What the customer reads. "Half tray", not "HALF_TRAY". */
  label: z.string().min(1).max(48),
  /** Integer cents. Never a float, never a string. See `money.ts`. */
  priceCents: z.number().int().positive().max(MAX_PRICE_CENTS),
  pricingStatus: z.enum(PRICING_STATUSES),
  /** Null until it has been counted in the kitchen. Never guessed. */
  piecesPerUnit: z.number().int().positive().nullable(),
  /** Null until it has been weighed in the kitchen. Goes on the label. */
  netWeightGrams: z.number().int().positive().nullable(),
  /**
   * Null until Stripe is wired. The browser never sends a price: it sends a
   * sku, a variant id and a quantity, and the checkout function looks this up.
   * Section 4 of docs/ARCHITECTURE.md.
   */
  stripePriceId: z
    .string()
    .regex(/^price_[A-Za-z0-9]+$/, "A Stripe price id looks like price_123abc.")
    .nullable(),
});

/**
 * Ingredient names that oblige an allergen declaration. The label and this
 * table have to agree, so the schema refuses a product where they do not.
 */
const ALLERGEN_TRIGGERS: ReadonlyArray<{ match: RegExp; allergen: Allergen }> = [
  { match: /\bflour\b/i, allergen: "Wheat" },
  { match: /\b(?:milk|butter|cream|yogurt|yoghurt)\b/i, allergen: "Milk" },
  { match: /\begg/i, allergen: "Egg" },
  { match: /\balmond/i, allergen: "Almonds" },
  { match: /\bwalnut/i, allergen: "Walnuts" },
  { match: /\bsesame\b/i, allergen: "Sesame" },
];

/** Almond flour is a nut, not wheat. Checked before the wheat trigger fires. */
const NOT_WHEAT = /\b(?:almond|walnut|nut|rice|corn|coconut)\s+flour\b/i;

export const productSchema = z
  .strictObject({
    /** Printed on the label and used in the `/p/{sku}` QR landing route. */
    sku: z.string().regex(SKU_RE, "A sku is upper case and hyphenated."),
    /** The URL segment. Stable forever once a link exists in the world. */
    slug: z.string().regex(SLUG_RE, "A slug is lower case and hyphenated."),
    name: z.string().min(1).max(80),
    /** Armenian name. Null until somebody who speaks it writes it. */
    nameHy: z.string().min(1).max(80).nullable(),
    description: z.string().min(20).max(600),
    /** Armenian copy ships in Phase 3. Null is honest until then. */
    descriptionHy: z.string().min(20).max(600).nullable(),
    /**
     * Names only, in the order they appear on the physical label, which by
     * law is descending by weight. Amounts are the recipe and never enter
     * this repository. `scripts/check-copy.mjs` enforces that repository
     * wide; the refinement below enforces it here.
     */
    ingredients: z.array(z.string().min(2).max(60)).min(1),
    allergens: z.array(z.enum(ALLERGENS)).min(1),
    nutrition: nutritionSchema.nullable(),
    variants: z.array(variantSchema).min(1),
    images: z.array(productImageSchema).min(1),
    /** Days between an order being placed and the tray being ready. */
    leadTimeDays: z.number().int().min(0).max(30),
    /** Weekday numbers this is baked on. Sunday is 0. */
    availableOn: z.array(z.number().int().min(0).max(6)).min(1),
    /** False hides it from the shop without deleting the record or the URL. */
    active: z.boolean(),
    sortOrder: z.number().int().min(0),
    /** How to keep it once it is home. Goes on the label and the page. */
    storage: z.string().min(10).max(240),
    /** Null until Hakop sets the window. It prints on every label. */
    bestByDays: z.number().int().positive().max(90).nullable(),
    servingSuggestion: z.string().min(10).max(240).nullable(),
    /**
     * Internal only. Never rendered. This is the list of things a human still
     * has to decide, carried next to the data it is about so it cannot drift
     * into a document nobody opens. `openQuestions()` reads it.
     */
    internalTodo: z.array(z.string().min(1)),
  })
  .superRefine((product, ctx) => {
    const fail = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });

    /* One id per variant. The cart keys on it. */
    const seen = new Set<string>();
    product.variants.forEach((variant, i) => {
      if (seen.has(variant.id)) {
        fail(`Duplicate variant id "${variant.id}".`, ["variants", i, "id"]);
      }
      seen.add(variant.id);
    });

    /* Exactly one hero, so no page has to pick arbitrarily. */
    const heroes = product.images.filter((img) => img.role === "hero");
    if (heroes.length !== 1) {
      fail(
        `A product needs exactly one image with role "hero". Found ${heroes.length}.`,
        ["images"],
      );
    }

    /* A bake day cannot be a day he is in class. */
    const days = new Set(product.availableOn);
    if (days.size !== product.availableOn.length) {
      fail("availableOn repeats a weekday.", ["availableOn"]);
    }
    const closed = commerce.neverBakeWeekdays as readonly number[];
    for (const day of product.availableOn) {
      if (closed.includes(day)) {
        fail(
          `${WEEKDAY_NAMES[day] ?? day} is never a bake day. See commerce.neverBakeWeekdays.`,
          ["availableOn"],
        );
      }
    }

    /* An order cannot be accepted later than the cutoff allows. */
    if (product.leadTimeDays < commerce.cutoff.daysBefore) {
      fail(
        "leadTimeDays is shorter than commerce.cutoff.daysBefore, so the " +
          "picker would offer a date the kitchen has already closed.",
        ["leadTimeDays"],
      );
    }

    /* No quantities in an ingredient name. Names are public, amounts are not. */
    product.ingredients.forEach((name, i) => {
      if (/\d/.test(name)) {
        fail(
          "An ingredient name contains a number. Names are legally required " +
            "and public. Amounts are the recipe and must not be in this file.",
          ["ingredients", i],
        );
      }
    });

    /* The declared allergens have to cover the declared ingredients. */
    const declared = new Set<Allergen>(product.allergens);
    for (const ingredient of product.ingredients) {
      for (const trigger of ALLERGEN_TRIGGERS) {
        if (!trigger.match.test(ingredient)) continue;
        if (trigger.allergen === "Wheat" && NOT_WHEAT.test(ingredient)) continue;
        if (!declared.has(trigger.allergen)) {
          fail(
            `"${ingredient}" requires the allergen "${trigger.allergen}" to be ` +
              "declared. The site and the printed label must say the same thing.",
            ["allergens"],
          );
        }
      }
    }
  });

export type Nutrition = z.infer<typeof nutritionSchema>;
export type ProductImage = z.infer<typeof productImageSchema>;
export type ProductVariant = z.infer<typeof variantSchema>;
export type Product = z.infer<typeof productSchema>;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Validate one record. Throws on anything invalid, because a half valid
 * product renders a half broken page and a wrong allergen line is worse than
 * a failed build. Every catalog source runs its rows through this.
 */
export function parseProduct(raw: unknown, where: string): Product {
  const result = productSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(
    `Invalid product in ${where}.\n${z.prettifyError(result.error)}\n` +
      "Fix the record. The build will not continue with a product this shape.",
  );
}

/* ------------------------------------------------------------------ */
/* Photographs                                                         */
/* ------------------------------------------------------------------ */

/**
 * Every photograph in the repository, keyed by its path from the project
 * root. Eager so that a missing file is a build error rather than a promise
 * nobody awaited.
 */
const LOCAL_PHOTOS = import.meta.glob<{ default: ImageMetadata }>(
  "/src/assets/photos/*.{jpg,jpeg,png,webp,avif}",
  { eager: true },
);

/**
 * Turn a catalog image reference into something `<Image>` accepts.
 *
 * A repository path becomes an `ImageMetadata` object, which lets astro:assets
 * generate a srcset and lets the page set a width and a height that are
 * guaranteed to match the file. An https URL is returned unchanged, which is
 * what the Phase 2 storage bucket will produce.
 *
 * Throws when the file is missing or when the recorded size disagrees with the
 * file, because either one means a page would ship the wrong aspect ratio and
 * shift its layout while the photograph loads.
 */
export function resolveImage(image: ProductImage): ImageMetadata | string {
  if (image.src.startsWith("https://")) return image.src;

  const key = image.src.startsWith("/") ? image.src : `/${image.src}`;
  const found = LOCAL_PHOTOS[key];
  if (!found) {
    const known = Object.keys(LOCAL_PHOTOS).sort().join("\n  ");
    throw new Error(
      `Catalog photograph not found: ${image.src}\nThe repository has:\n  ${known}`,
    );
  }

  const asset = found.default;
  if (asset.width !== image.width || asset.height !== image.height) {
    throw new Error(
      `Catalog photograph ${image.src} does not match the file. The catalog ` +
        `records ${image.width} by ${image.height}, the file is ${asset.width} ` +
        `by ${asset.height}. Correct the catalog so pages can set an explicit ` +
        "width and height without shifting the layout.",
    );
  }
  return asset;
}

/** The one image a card, a share preview or a hero should use. */
export function heroImage(product: Product): ProductImage {
  const hero = product.images.find((img) => img.role === "hero");
  if (!hero) {
    // The schema guarantees one. This is here so the type is not a lie.
    throw new Error(`Product ${product.slug} has no hero image.`);
  }
  return hero;
}

/** Everything except the hero, in catalog order. */
export function galleryImages(product: Product): ProductImage[] {
  return product.images.filter((img) => img.role !== "hero");
}

export function imagesWithRole(product: Product, role: ImageRole): ProductImage[] {
  return product.images.filter((img) => img.role === role);
}

/* ------------------------------------------------------------------ */
/* Collections                                                         */
/* ------------------------------------------------------------------ */

/** Catalog order: sortOrder, then name, so the shop never shuffles. */
export function sortProducts(products: readonly Product[]): Product[] {
  return [...products].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en"),
  );
}

/** What the shop shows. An inactive product keeps its URL and its data. */
export function activeProducts(products: readonly Product[]): Product[] {
  return sortProducts(products.filter((p) => p.active));
}

/* ------------------------------------------------------------------ */
/* Variants and price                                                  */
/* ------------------------------------------------------------------ */

export function findVariant(
  product: Product,
  variantId: string,
): ProductVariant | null {
  return product.variants.find((v) => v.id === variantId) ?? null;
}

/** The cheapest variant. What a card shows, and what a picker preselects. */
export function defaultVariant(product: Product): ProductVariant {
  const sorted = [...product.variants].sort((a, b) => a.priceCents - b.priceCents);
  const first = sorted[0];
  if (!first) throw new Error(`Product ${product.slug} has no variants.`);
  return first;
}

/** Integer cents, low and high. Equal when there is one variant. */
export function priceRangeCents(product: Product): { low: number; high: number } {
  const prices = product.variants.map((v) => v.priceCents);
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

/* ------------------------------------------------------------------ */
/* What the store is allowed to do with a product                      */
/* ------------------------------------------------------------------ */

/** True while any price on this product is still a guess. */
export function pricingIsPlaceholder(product: Product): boolean {
  return product.variants.some((v) => v.pricingStatus === "placeholder");
}

export function variantIsSellable(variant: ProductVariant): boolean {
  return variant.pricingStatus === "confirmed" && variant.stripePriceId !== null;
}

/**
 * The single question a page should ask before it renders a price with a
 * button next to it. Four things have to be true at once: the store is open,
 * the compliance configuration is complete (`storeOpen` already folds that
 * in), the product is active, and at least one variant has a price a human
 * confirmed and a Stripe price to charge it against.
 *
 * When this is false the page still renders. It shows the photographs, the
 * story, the ingredients and the allergens, and an email capture instead of
 * a cart. That is the coming soon state, not an error state.
 */
export function isPurchasable(product: Product): boolean {
  return storeOpen && product.active && product.variants.some(variantIsSellable);
}

/* ------------------------------------------------------------------ */
/* Label and availability copy                                         */
/* ------------------------------------------------------------------ */

/** "Contains: Wheat, Milk, Egg, Almonds, Walnuts, Sesame." */
export function allergenSentence(product: Product): string {
  return `Contains: ${product.allergens.join(", ")}.`;
}

/** The ingredient line, in label order. Names only. */
export function ingredientSentence(product: Product): string {
  return `Ingredients: ${product.ingredients.join(", ")}.`;
}

export function bakesOn(product: Product, weekday: number): boolean {
  return product.availableOn.includes(weekday);
}

/** ["Sunday", "Monday", ...] in week order, for the availability line. */
export function availableWeekdayNames(product: Product): string[] {
  return [...product.availableOn]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_NAMES[day] ?? String(day));
}

/* ------------------------------------------------------------------ */
/* What a human still has to answer                                    */
/* ------------------------------------------------------------------ */

/**
 * Everything about this product that is still a placeholder or a blank.
 * The admin will show this, and it is worth reading before the store opens.
 * It is derived, so it cannot go stale the way a checklist in a document can.
 */
export function openQuestions(product: Product): string[] {
  const questions: string[] = [...product.internalTodo];

  for (const variant of product.variants) {
    if (variant.pricingStatus === "placeholder") {
      questions.push(`"${variant.label}" carries placeholder pricing. Hakop must confirm it.`);
    }
    if (variant.piecesPerUnit === null) {
      questions.push(`"${variant.label}" has no piece count. Count one in the kitchen.`);
    }
    if (variant.netWeightGrams === null) {
      questions.push(`"${variant.label}" has no net weight. Weigh one. It goes on the label.`);
    }
    if (variant.stripePriceId === null) {
      questions.push(`"${variant.label}" has no Stripe price. Checkout cannot charge for it.`);
    }
  }

  if (product.bestByDays === null) {
    questions.push("No best by window is set. It prints on every label.");
  }
  if (product.nutrition === null) {
    questions.push("No nutrition panel. Voluntary, and it needs a lab, not an estimate.");
  }
  if (product.nameHy === null || product.descriptionHy === null) {
    questions.push("Armenian copy is missing. The family writes it, nobody else.");
  }

  return questions;
}
