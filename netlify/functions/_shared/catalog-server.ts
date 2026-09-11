/**
 * The catalog, read server side, by the only code that is allowed to decide
 * what something costs.
 *
 * WHY NOT src/lib/catalog-source.ts
 *
 * That module reads an Astro content collection through `astro:content`, and
 * a Netlify function cannot see that virtual module. `src/lib/catalog.ts` is
 * closer, but it holds an `import.meta.glob` of the photography, which Vite
 * resolves at build time and esbuild does not. So this file reads the same
 * JSON from `src/content/products/` off disk and validates it against the
 * projection below.
 *
 * The projection is deliberately narrow. A function that is about to take
 * money needs the sku, the variant, the price, the pieces and the Stripe
 * price id. It has no business knowing about photographs, and a schema that
 * only covers what is used cannot fail a checkout over an unrelated field.
 * Unknown keys are dropped rather than refused, so the page schema can gain
 * a field without taking checkout down.
 *
 * `netlify.toml` already carries `included_files = ["src/content/**"]`, which
 * is what puts these files inside the function bundle.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { env } from "./env";

/* ------------------------------------------------------------------ */
/* The projection                                                      */
/* ------------------------------------------------------------------ */

export const serverVariantSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Integer cents, always. The only price this codebase will ever charge. */
  priceCents: z.number().int().positive(),
  pricingStatus: z.enum(["placeholder", "confirmed"]),
  /**
   * How many pieces one unit holds. Null until somebody has counted a tray.
   * Capacity cannot be reserved without it, and checkout refuses rather than
   * guessing. See resolveLines below.
   */
  piecesPerUnit: z.number().int().positive().nullable().default(null),
  netWeightGrams: z.number().int().positive().nullable().default(null),
  stripePriceId: z.string().min(1).nullable().default(null),
  /** Optional per variant Stripe Tax category. Falls back to the shop default. */
  taxCode: z.string().min(1).nullable().optional(),
});

export const serverProductSchema = z.object({
  sku: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  active: z.boolean(),
  leadTimeDays: z.number().int().nonnegative(),
  variants: z.array(serverVariantSchema).min(1),
  taxCode: z.string().min(1).nullable().optional(),
});

export type ServerVariant = z.infer<typeof serverVariantSchema>;
export type ServerProduct = z.infer<typeof serverProductSchema>;

/* ------------------------------------------------------------------ */
/* Reading it                                                          */
/* ------------------------------------------------------------------ */

const CONTENT_RELATIVE = join("src", "content", "products");

/**
 * Where the product JSON lives, tried in order.
 *
 * On Netlify the included files sit under the bundle root, which is the
 * process working directory. In a test and in `netlify dev` the working
 * directory is the repository root. The walk up from this module covers the
 * case where neither is true, which is the one that is painful to debug at
 * three in the morning.
 */
function candidateDirs(): string[] {
  const out: string[] = [];
  const override = env("CATALOG_CONTENT_DIR");
  if (override !== null) out.push(resolve(override));
  out.push(resolve(process.cwd(), CONTENT_RELATIVE));

  let here = dirname(fileURLToPath(import.meta.url));
  for (let step = 0; step < 6; step += 1) {
    out.push(join(here, CONTENT_RELATIVE));
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  return out;
}

async function readProductDir(): Promise<{ dir: string; files: string[] }> {
  const tried: string[] = [];
  for (const dir of candidateDirs()) {
    tried.push(dir);
    try {
      const names = await readdir(dir);
      const files = names.filter((name) => name.endsWith(".json")).sort();
      if (files.length > 0) return { dir, files };
    } catch {
      // Not here. Try the next candidate.
    }
  }
  throw new Error(
    "No product JSON found. Looked in:\n  " +
      tried.join("\n  ") +
      "\nnetlify.toml must keep included_files = [\"src/content/**\"], or set " +
      "CATALOG_CONTENT_DIR to the directory holding the product records.",
  );
}

/*
  Tier 1 data changes only when somebody publishes, and publishing triggers a
  rebuild and a fresh deploy, so a warm function holding the catalog in memory
  cannot go stale in a way a redeploy does not fix. Availability is Tier 2 and
  is never cached anywhere. Section 1 of docs/ARCHITECTURE.md.
*/
let cached: Promise<ServerProduct[]> | null = null;

async function readCatalog(): Promise<ServerProduct[]> {
  const { dir, files } = await readProductDir();
  const products: ServerProduct[] = [];

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error(`${file} is not valid JSON: ${String(cause)}`);
    }
    const parsed = serverProductSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${file} does not carry the fields checkout needs.\n` +
          JSON.stringify(parsed.error.issues, null, 2),
      );
    }
    products.push(parsed.data);
  }

  const skus = new Set<string>();
  for (const product of products) {
    if (skus.has(product.sku)) {
      throw new Error(`Two products share the sku ${product.sku}.`);
    }
    skus.add(product.sku);
  }
  return products;
}

export function loadServerCatalog(): Promise<ServerProduct[]> {
  cached ??= readCatalog();
  return cached;
}

/** Tests and the local dev server call this after editing a product file. */
export function resetCatalogCache(): void {
  cached = null;
}

/* ------------------------------------------------------------------ */
/* Resolving what a browser asked for                                  */
/* ------------------------------------------------------------------ */

/** What the browser is allowed to send. Note what is missing: any amount. */
export interface RequestedLine {
  readonly sku: string;
  readonly variantId: string;
  readonly qty: number;
}

/** What the server decided. Every number here came out of the catalog. */
export interface ResolvedLine {
  readonly sku: string;
  readonly slug: string;
  readonly productName: string;
  readonly variantId: string;
  readonly variantLabel: string;
  readonly qty: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
  readonly piecesPerUnit: number;
  readonly piecesTotal: number;
  readonly stripePriceId: string | null;
  readonly taxCode: string;
  readonly leadTimeDays: number;
}

export const LINE_REJECTION_CODES = [
  "unknown-product",
  "unknown-variant",
  "product-inactive",
  "placeholder-price",
  "pieces-not-counted",
  "quantity-out-of-range",
] as const;

export type LineRejectionCode = (typeof LINE_REJECTION_CODES)[number];

export type ResolveLinesResult =
  | { readonly ok: true; readonly lines: readonly ResolvedLine[]; readonly subtotalCents: number; readonly piecesTotal: number }
  | { readonly ok: false; readonly code: LineRejectionCode; readonly message: string; readonly sku: string; readonly variantId: string };

function reject(
  code: LineRejectionCode,
  message: string,
  sku: string,
  variantId: string,
): ResolveLinesResult {
  return { ok: false, code, message, sku, variantId };
}

/**
 * Turn what the browser asked for into what it will actually be charged.
 *
 * Every refusal here is a refusal to take money, not a warning. In
 * particular:
 *
 * `placeholder-price` stops a sale at a number nobody has agreed to. Both
 * tray prices in the catalog are marked placeholder today (brief open
 * decision 5) and selling at a placeholder is worse than not selling.
 *
 * `pieces-not-counted` stops a sale whose effect on capacity cannot be
 * measured. If a tray's piece count is unknown, reserving capacity for it is
 * a guess, and a guess here oversells a bake day. Refusing is the honest
 * answer and it is visible to Hakop the moment he tries a test order.
 */
export function resolveLines(
  catalog: readonly ServerProduct[],
  requested: readonly RequestedLine[],
  limits: { readonly maxQtyPerLine: number; readonly defaultTaxCode: string },
): ResolveLinesResult {
  const lines: ResolvedLine[] = [];
  let subtotalCents = 0;
  let piecesTotal = 0;

  for (const line of requested) {
    const product = catalog.find((candidate) => candidate.sku === line.sku);
    if (product === undefined) {
      return reject("unknown-product", "That item is not in the shop.", line.sku, line.variantId);
    }
    if (!product.active) {
      return reject("product-inactive", `${product.name} is not for sale right now.`, line.sku, line.variantId);
    }

    const variant = product.variants.find((candidate) => candidate.id === line.variantId);
    if (variant === undefined) {
      return reject("unknown-variant", "That size is not available.", line.sku, line.variantId);
    }
    if (variant.pricingStatus !== "confirmed") {
      return reject(
        "placeholder-price",
        "That price is not final yet, so it cannot be sold. Ask Hakop to " +
          "confirm the price in the admin before opening the store.",
        line.sku,
        line.variantId,
      );
    }
    if (variant.piecesPerUnit === null) {
      return reject(
        "pieces-not-counted",
        "That size has no piece count yet, so a bake day cannot be reserved " +
          "for it. Set piecesPerUnit on the variant before opening the store.",
        line.sku,
        line.variantId,
      );
    }

    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > limits.maxQtyPerLine) {
      return reject(
        "quantity-out-of-range",
        `Choose between 1 and ${limits.maxQtyPerLine} of any one size.`,
        line.sku,
        line.variantId,
      );
    }

    const lineTotalCents = variant.priceCents * line.qty;
    subtotalCents += lineTotalCents;
    const pieces = variant.piecesPerUnit * line.qty;
    piecesTotal += pieces;

    lines.push({
      sku: product.sku,
      slug: product.slug,
      productName: product.name,
      variantId: variant.id,
      variantLabel: variant.label,
      qty: line.qty,
      unitPriceCents: variant.priceCents,
      lineTotalCents,
      piecesPerUnit: variant.piecesPerUnit,
      piecesTotal: pieces,
      stripePriceId: variant.stripePriceId,
      taxCode: variant.taxCode ?? product.taxCode ?? limits.defaultTaxCode,
      leadTimeDays: product.leadTimeDays,
    });
  }

  return { ok: true, lines, subtotalCents, piecesTotal };
}

/** The longest lead time in an order. The whole order waits for the slowest. */
export function maxLeadTimeDays(lines: readonly ResolvedLine[]): number {
  return lines.reduce((longest, line) => Math.max(longest, line.leadTimeDays), 0);
}
