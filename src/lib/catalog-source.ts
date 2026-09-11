/**
 * The catalog adapter.
 *
 * Every read of product data in this codebase goes through here. There is one
 * interface, `CatalogSource`, and today there is one implementation of it,
 * `fileSource`, which reads the JSON in `src/content/products/` through an
 * Astro content collection.
 *
 * Phase 2 adds `supabaseSource`, which reads the same shape out of Postgres so
 * that Hakop can add a pastry from a form instead of a git commit. Nothing
 * outside this file changes when that happens: the return type is identical,
 * both implementations validate with the same `productSchema`, and the choice
 * is one environment variable. Section 2 of docs/ARCHITECTURE.md explains why
 * the interface goes in before it is needed rather than after.
 *
 * This is Tier 1 data: identity, baked at build time. Whether a bake date is
 * sold out is Tier 2 and is never read from here, never cached, and never
 * baked into a page. It comes from `check-availability` at request time.
 */

import { getCollection } from "astro:content";
import type { Product } from "@lib/catalog";
import { activeProducts, sortProducts } from "@lib/catalog";

export type CatalogSourceName = "file" | "supabase";

/**
 * The whole contract. Two reads, both async, both returning fully validated
 * products in catalog order. Keep it this small: everything else a page needs
 * is a pure function of a `Product` and lives in `catalog.ts`.
 */
export interface CatalogSource {
  /** Which implementation this is. Useful in a build log, and in the admin. */
  readonly name: CatalogSourceName;
  /**
   * Every product, active or not, sorted by `sortOrder` then name. Inactive
   * products are included so a route can still resolve a URL that exists in
   * the world. Use `listPublishedProducts()` for anything customer facing.
   */
  listProducts(): Promise<Product[]>;
  /** One product by slug, or null. Null is a 404, not an error. */
  getProduct(slug: string): Promise<Product | null>;
}

/* ------------------------------------------------------------------ */
/* The file backed implementation, which is what runs today            */
/* ------------------------------------------------------------------ */

/*
  A static build asks for the catalog once per page. Reading and validating it
  once is worth it, and safe, because a build is a single process with a fixed
  set of files. A network backed source must NOT copy this: see the note in
  the Supabase contract below.
*/
let filePromise: Promise<Product[]> | null = null;

async function loadFromCollection(): Promise<Product[]> {
  const entries = await getCollection("products");

  if (entries.length === 0) {
    throw new Error(
      "No products found in src/content/products/. The shop cannot render " +
        "an empty catalog, and an empty catalog is almost always a loader " +
        "path problem rather than a real one.",
    );
  }

  const products: Product[] = [];
  const seenSkus = new Set<string>();

  for (const entry of entries) {
    /*
      The collection schema is `productSchema`, so this is already validated.
      The type below is the assertion that says so: if the schema and the
      Product type ever drift apart, this line stops compiling.
    */
    const product: Product = entry.data;

    /*
      The glob loader derives the entry id from the file name. The file name
      and the slug in the file have to agree, or a URL and its data point at
      different records and the mismatch only shows up as a 404 in production.
    */
    if (entry.id !== product.slug) {
      throw new Error(
        `src/content/products/${entry.id}.json declares slug "${product.slug}". ` +
          "The file name and the slug must match, because the file name is " +
          "what the content layer keys the entry on.",
      );
    }

    if (seenSkus.has(product.sku)) {
      throw new Error(
        `Two products share the sku "${product.sku}". A sku is printed on the ` +
          "label and resolved by the /p/{sku} QR route, so it has to be unique.",
      );
    }
    seenSkus.add(product.sku);

    products.push(product);
  }

  return sortProducts(products);
}

function loadFileCatalog(): Promise<Product[]> {
  /*
    In dev the JSON is edited while the server is running and this module is
    not necessarily invalidated when it changes, so a memoised copy would go
    stale and look like a bug in the page. Read it fresh instead. A build is
    one process over a fixed set of files, so there it is memoised.
  */
  if (import.meta.env.DEV) return loadFromCollection();
  filePromise ??= loadFromCollection();
  return filePromise;
}

export const fileSource: CatalogSource = {
  name: "file",

  listProducts() {
    return loadFileCatalog();
  },

  /*
    Deliberately not `this.listProducts()`. These methods survive being pulled
    off the object and passed around, which is exactly what a page that
    destructures the source would do.
  */
  async getProduct(slug: string) {
    const all = await loadFileCatalog();
    return all.find((product) => product.slug === slug) ?? null;
  },
};

/* ------------------------------------------------------------------ */
/* The Supabase implementation, Phase 2                                */
/* ------------------------------------------------------------------ */

/*
  WHAT `supabaseSource` MUST RETURN
  =================================

  It implements `CatalogSource` above and nothing else. No extra methods, no
  extra fields, no Supabase types leaking past this file. If a page can tell
  which source it is talking to, the adapter is wrong.

  1. Shape.

     `listProducts()` resolves to `Product[]`, sorted by `sortOrder` then name,
     including inactive products. `getProduct(slug)` resolves to one `Product`
     or to null. Not undefined, not a thrown error for a missing row: a missing
     product is a 404 and the route decides what to do about it.

  2. Validation.

     Every row goes through `parseProduct(row, "supabase:products/" + slug)`
     from `catalog.ts`, the same function the file source is validated with.
     A row that does not parse throws and fails the build. A database is not a
     reason to trust data: an admin form can write a bad row just as easily as
     a text editor can, and a wrong allergen list is the worst thing this site
     could publish.

  3. Column mapping.

     Postgres is snake case, the model is camel case, so the query selects and
     renames. Nested records are their own tables, ordered explicitly:

       products
         sku, slug, name, name_hy, description, description_hy,
         ingredients text[], allergens text[], nutrition jsonb,
         lead_time_days, available_on int[], active, sort_order,
         storage, best_by_days, serving_suggestion, internal_todo text[]

       product_variants   (product_id, position)
         variant_id, label, price_cents, pricing_status,
         pieces_per_unit, net_weight_grams, stripe_price_id

       product_images     (product_id, position)
         src, alt, width, height, role

     `ingredients` keeps its stored order. It is the order printed on the
     label, which the law fixes, so never sort it in the query or in the page.

     `variants` and `images` come back ordered by their `position` column.
     `product_images.src` will hold an absolute https URL into the storage
     bucket rather than a repository path. `resolveImage()` already handles
     both, so no page changes.

  4. Caching.

     None. `fileSource` memoises because a build reads a fixed set of files in
     one process. A network source must not: the admin publishes a change, the
     Netlify build hook fires, and a memoised module in a warm function would
     serve the old catalog. Fetch per call and let the build be the cache.

  5. Credentials.

     The anon key with row level security allowing read on published rows, and
     never the service key. This module is imported by page code. Anything it
     can see could end up in a build artifact.

  6. What does not move here.

     Sold out dates, remaining batches, blackout dates and the order cutoff.
     Those are Tier 2, they are read live by `check-availability`, and putting
     them in the catalog would bake a stale answer into a static page. Section
     1 of docs/ARCHITECTURE.md.
*/

/* ------------------------------------------------------------------ */
/* Choosing an implementation                                          */
/* ------------------------------------------------------------------ */

function configuredSourceName(): CatalogSourceName {
  const raw = (import.meta.env as Record<string, unknown>)["CATALOG_SOURCE"];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "" || value === "file") return "file";
  if (value === "supabase") return "supabase";
  throw new Error(
    `CATALOG_SOURCE is "${value}". It must be "file" or "supabase".`,
  );
}

/**
 * The active catalog source. Pages and functions call this, never a concrete
 * implementation, so that switching backends stays a one variable change.
 */
export function getCatalogSource(): CatalogSource {
  const name = configuredSourceName();
  if (name === "file") return fileSource;
  throw new Error(
    "CATALOG_SOURCE is set to \"supabase\" but supabaseSource is not written " +
      "yet. It belongs in this file, against the contract documented above. " +
      "Set CATALOG_SOURCE to \"file\" to build from src/content/products/.",
  );
}

/* ------------------------------------------------------------------ */
/* The two calls a page actually makes                                 */
/* ------------------------------------------------------------------ */

/** Every product, including inactive ones. */
export function listProducts(): Promise<Product[]> {
  return getCatalogSource().listProducts();
}

/** What the shop and the sitemap show. */
export async function listPublishedProducts(): Promise<Product[]> {
  return activeProducts(await getCatalogSource().listProducts());
}

/** One product by slug, or null for a 404. */
export function getProduct(slug: string): Promise<Product | null> {
  return getCatalogSource().getProduct(slug);
}

/** One product by sku, for the `/p/{sku}` label route. */
export async function getProductBySku(sku: string): Promise<Product | null> {
  const all = await getCatalogSource().listProducts();
  return all.find((product) => product.sku === sku) ?? null;
}
