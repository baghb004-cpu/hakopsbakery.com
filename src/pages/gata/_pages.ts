/**
 * The pages under /gata, in one list.
 *
 * Underscore prefixed, so Astro does not route it. The hub reads it to build
 * the way in, and every explainer reads it to build the way sideways, so a
 * new page under /gata is added here once and appears in both.
 *
 * `legacyAnchors` are the ids the section had while /gata was a single page.
 * Those ids were real link targets (`/gata#serve-title` and the rest), and a
 * fragment never reaches the server, so no redirect can catch one. The hub
 * carries them instead, which puts an old link next to the link to the page
 * that section became. Two of the old sections became one page, which is why
 * this is a list rather than a string.
 */

export interface GataPage {
  /** The segment under /gata. */
  slug: string;
  /**
   * The h1 on the page itself. It has to stand on its own, because somebody
   * arrives here from a search with no idea what "it" refers to.
   */
  heading: string;
  /**
   * The same page in a list on /gata, where the subject is already the
   * heading above the list and repeating it in every row reads as filler.
   */
  label: string;
  /** One sentence, shown on the hub. Not a teaser: a real answer in short. */
  blurb: string;
  legacyAnchors: readonly string[];
}

export const GATA_PAGES: readonly GataPage[] = [
  {
    slug: "rolled-and-sliced",
    heading: "The rolled and sliced kind of gata",
    label: "The rolled and sliced kind",
    blurb:
      "There is more than one kind of gata. Hakop's is the one where the filling is turned inside the dough and the log is cut across into pieces.",
    legacyAnchors: ["what-title"],
  },
  {
    slug: "what-is-in-it",
    heading: "What is in gata",
    label: "What is in it",
    blurb:
      "The ingredient names in the order they are printed on the label, and the allergen statement that goes with them.",
    legacyAnchors: ["inside-title"],
  },
  {
    slug: "how-to-serve-it",
    heading: "How to serve gata",
    label: "How to serve it",
    blurb: "Room temperature, with coffee or tea, cut and eaten by hand from a tray put out whole.",
    legacyAnchors: ["serve-title"],
  },
  {
    slug: "how-to-say-it",
    heading: "How to say gata",
    label: "How to say it, and the other names",
    /* The phonetic is on the hub as well as on the page, deliberately. Two
       other pages link here promising to say how the word sounds, and a hub
       that only promises to tell you somewhere else has broken that. Four
       characters shared between two pages is not duplicate content. */
    blurb:
      "Said gah-TAH, two syllables with the second one stronger. Some households call the same pastry nazook, and some call it kata.",
    legacyAnchors: ["say-title", "names-title"],
  },
];

export const gataHref = (slug: string): string => `/gata/${slug}/`;

/** One page by slug, or a build error naming the slug that is not in the list. */
export function gataPage(slug: string): GataPage {
  const page = GATA_PAGES.find((candidate) => candidate.slug === slug);
  if (page === undefined) {
    throw new Error(
      `There is no /gata page with the slug "${slug}". Add it to GATA_PAGES in ` +
        "src/pages/gata/_pages.ts, which is what builds the links between them.",
    );
  }
  return page;
}
