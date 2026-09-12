/**
 * Content collections.
 *
 * Two of them.
 *
 * `products` is Tier 1 of the catalog: identity, baked at build time. One
 * JSON file per product in `src/content/products/`, validated on every build
 * against the schema in `src/lib/catalog.ts`.
 *
 * `faq` is one markdown file per question in `src/content/faq/`. Each file
 * becomes its own page at `/faq/{slug}` with its own title and its own meta
 * description, and the index at `/faq` is built from the same files. See
 * docs/DECISIONS.md D-008 for why a question is a page and not a fragment.
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
import { z } from "astro/zod";
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

/* ------------------------------------------------------------------ */
/* Questions                                                           */
/* ------------------------------------------------------------------ */

/**
 * The four groups a question can belong to, in the order they are shown.
 *
 * The headings and the ordering live next to the pages that render them, in
 * `src/pages/faq/_answers.ts`. This list is only the vocabulary the schema
 * will accept. The index page checks the two against each other and fails the
 * build with a named file if they ever drift.
 */
const FAQ_GROUPS = ["pastry", "ordering", "getting-it", "kitchen"] as const;

/**
 * Conditions an answer may be written against. They are the same three the
 * rest of the site branches on, named once so that a typo in a markdown file
 * fails the build instead of silently hiding a paragraph.
 */
const FAQ_CONDITIONS = [
  "storeOpen",
  "registrationIssued",
  "registrationPending",
  "bestByUnknown",
] as const;

/**
 * A panel that follows the answer, for something that has not been decided
 * yet. Kept out of the markdown body because it is a distinct block with its
 * own styling and, in two cases, its own condition: the "best by window is
 * not set" panel has to disappear on the day somebody sets it.
 */
const faqNote = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  /** Shown always when absent. Otherwise shown only while the flag holds. */
  when: z.enum(FAQ_CONDITIONS).optional(),
});

const faq = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/faq",
    /* File name is the entry id, as with products. `slug` is checked
       against it at render time so the two cannot drift. */
    generateId: ({ entry }) => entry.replace(/\.md$/i, ""),
  }),
  schema: z.object({
    /** Shown as the h1 on the question's own page, and in the index. */
    question: z.string().min(1),
    /** The URL segment. Must equal the file name. */
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "A slug is lower case words joined by hyphens."),
    /**
     * The id this question used to have as a fragment on the old single page
     * FAQ, where it differs from the slug. The index still carries it as an
     * anchor, so a link somebody sent last month still lands on the right
     * entry. A fragment never reaches the server, so this cannot be a
     * redirect.
     */
    legacyAnchor: z.string().optional(),
    group: z.enum(FAQ_GROUPS),
    /** Position within the group. Unique per group, checked at render. */
    order: z.number().int().positive(),
    /** One or two sentences, shown under the question on the index. */
    short: z.string().min(1),
    /**
     * The title element for this question's own page. Base.astro appends the
     * business name, so keep it under about 50 characters and do not repeat
     * the bakery in it.
     */
    seoTitle: z.string().min(1).max(58),
    /**
     * Written for this question, never the site default.
     *
     * The bound here is loose because a description that branches on the
     * store being open carries both branches in the file and ships only one.
     * What actually reaches a search result is measured after the branch is
     * taken, in `checkedMetaDescription` in src/pages/faq/_answers.ts.
     */
    metaDescription: z.string().min(60).max(320),
    /** Slugs of questions in OTHER groups worth reading next. */
    related: z.array(z.string()).default([]),
    notes: z.array(faqNote).default([]),
  }),
});

export const collections = { products, faq };

