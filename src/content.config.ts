/**
 * Content collections.
 *
 * Tier 1 of the catalog: identity, baked at build time. One JSON file per
 * product in `src/content/products/`, validated on every build against the
 * schema in `src/lib/catalog.ts`.
 *
 * The schema lives in `catalog.ts` rather than here on purpose. A Netlify
 * function cannot import `astro:content`, but it can import `catalog.ts`, so
 * the checkout function validates a product with the same schema this build
 * does. One definition, two callers, no drift.
 *
 * A product that does not parse fails the build with a message naming the
 * file and the field. It never renders a half broken page. That is deliberate:
 * the fields here are the ingredient list and the allergen statement, and
 * those have to be identical to what is printed on the physical label.
 */

import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { productSchema } from "@lib/catalog";

const products = defineCollection({
  loader: glob({
    pattern: "**/*.json",
    base: "./src/content/products",
    /*
      The file name is the entry id, so gata.json becomes the entry "gata".

      This override matters. Left to itself the loader takes the id from the
      `slug` field inside the file, which means the file name and the slug can
      drift apart and nothing notices. Keying on the file name instead lets
      `fileSource` compare the two and refuse the build when they disagree,
      because a URL and its data pointing at different records is the kind of
      bug that only shows up in production.
    */
    generateId: ({ entry }) => entry.replace(/\.json$/i, ""),
  }),
  schema: productSchema,
});

export const collections = { products };
