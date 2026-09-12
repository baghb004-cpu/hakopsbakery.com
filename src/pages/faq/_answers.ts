/**
 * The shared half of the questions section.
 *
 * Underscore prefixed, so Astro does not route it. It is imported by
 * `src/pages/faq.astro` (the index) and `src/pages/faq/[slug].astro` (one
 * question per page), which have to agree on the groups, the ordering, and
 * the values that get filled into an answer.
 *
 * WHY THERE IS A TEMPLATE STEP AT ALL
 *
 * The answers are copy, so they belong in `src/content/faq/` where a person
 * can read and edit them. But several of them state a fact that is held in
 * configuration: the lead time, the cutoff, the six allergens, the county,
 * the home kitchen statement. Those must never be typed into prose, because
 * the day one of them changes the page has to change with it. So the markdown
 * carries a named placeholder and this module fills it in at build time.
 *
 * Three answers also branch on whether the store is open or the registration
 * has been issued, which is why there is a conditional as well as a value.
 * That is the whole language: `{name}` and `{if:flag} ... {else} ... {end}`.
 * An unknown name in either position fails the build with the file that
 * contains it, so a typo cannot quietly delete a paragraph.
 */

import type { CollectionEntry } from "astro:content";

import { business, commerce, compliance, complianceIsComplete, storeOpen } from "@config/site";
import { getProduct, listPublishedProducts } from "@lib/catalog-source";
import { WEEKDAY_NAMES, availableWeekdayNames } from "@lib/catalog";
import { DEFAULT_DELIVERY_ZIPS } from "@lib/zones";

export type FaqEntry = CollectionEntry<"faq">;
export type FaqGroupId = FaqEntry["data"]["group"];

/* ------------------------------------------------------------------ */
/* Groups                                                              */
/* ------------------------------------------------------------------ */

/**
 * The groups, in the order the index shows them, with the heading each one
 * gets. The ids have to match the enum in `src/content.config.ts`; the index
 * page asserts that every entry's group is listed here.
 */
export interface FaqGroup {
  id: FaqGroupId;
  /** The heading over the group on the index. */
  heading: string;
  /** The same thing written to sit inside a sentence, so a cross reference
      can read "other questions about getting it to you". */
  inline: string;
  blurb: string;
}

export const FAQ_GROUPS: ReadonlyArray<FaqGroup> = [
  {
    id: "pastry",
    heading: "The pastry",
    inline: "the pastry",
    blurb: "What gata is, what is in it, and how to keep a tray.",
  },
  {
    id: "ordering",
    heading: "Ordering",
    inline: "ordering",
    blurb: "When ordering opens, how far ahead to order, and changing your mind.",
  },
  {
    id: "getting-it",
    heading: "Getting it to you",
    inline: "getting it to you",
    blurb: "Pickup in Cypress, local delivery, and shipping inside California.",
  },
  {
    id: "kitchen",
    heading: "The kitchen",
    inline: "the kitchen",
    blurb: "What a home kitchen operation is, and who does the baking.",
  },
];

/** One group by id, or a build error naming the id that has no entry here. */
export function faqGroup(id: FaqGroupId): FaqGroup {
  const group = FAQ_GROUPS.find((candidate) => candidate.id === id);
  if (group === undefined) {
    throw new Error(
      `The question group "${id}" has no heading. Add it to FAQ_GROUPS in ` +
        "src/pages/faq/_answers.ts, or correct the group in the markdown file.",
    );
  }
  return group;
}

/* ------------------------------------------------------------------ */
/* Sorting and lookup                                                  */
/* ------------------------------------------------------------------ */

/** Group order first, then the order field, then the question alphabetically. */
export function sortQuestions(entries: FaqEntry[]): FaqEntry[] {
  const rank = new Map(FAQ_GROUPS.map((group, index) => [group.id, index]));
  return [...entries].sort((a, b) => {
    const groupDelta = (rank.get(a.data.group) ?? 99) - (rank.get(b.data.group) ?? 99);
    if (groupDelta !== 0) return groupDelta;
    if (a.data.order !== b.data.order) return a.data.order - b.data.order;
    return a.data.question.localeCompare(b.data.question);
  });
}

/**
 * Every question, sorted, with the file name and the slug checked against
 * each other and the slugs checked for duplicates.
 *
 * The file name is the entry id, so a file called `pickup.md` whose front
 * matter says `slug: pickups` would put the page at one URL while every link
 * to it pointed at another. That is the kind of thing nobody notices until a
 * customer reports a dead link, so it fails the build instead.
 */
export function checkedQuestions(entries: FaqEntry[]): FaqEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.id !== entry.data.slug) {
      throw new Error(
        `src/content/faq/${entry.id}.md declares slug "${entry.data.slug}". ` +
          "The file name and the slug have to match, because the file name is " +
          "what the route is generated from.",
      );
    }
    if (seen.has(entry.data.slug)) {
      throw new Error(`Two questions both claim the slug "${entry.data.slug}".`);
    }
    seen.add(entry.data.slug);
    faqGroup(entry.data.group);
  }
  return sortQuestions(entries);
}

/** The path a question lives at. One place, so a rename is one edit. */
export function questionHref(slug: string): string {
  return `/faq/${slug}/`;
}

/* ------------------------------------------------------------------ */
/* The values an answer can name                                       */
/* ------------------------------------------------------------------ */

export interface AnswerContext {
  values: Readonly<Record<string, string>>;
  flags: Readonly<Record<string, boolean>>;
}

/**
 * Reads the configuration and the catalog once, and returns everything an
 * answer is allowed to refer to.
 *
 * Nothing here is invented. Every value is either a configured fact or a
 * sentence assembled from configured facts, which is the same rule the old
 * single page FAQ followed.
 */
export async function buildAnswerContext(): Promise<AnswerContext> {
  const product = (await getProduct("gata")) ?? (await listPublishedProducts())[0] ?? null;

  const leadDays = product?.leadTimeDays ?? commerce.cutoff.daysBefore;

  const rawHour = commerce.cutoff.hour;
  const cutoffHour = rawHour % 12 === 0 ? 12 : rawHour % 12;
  const cutoffLabel = `${cutoffHour}${rawHour < 12 ? "am" : "pm"}`;
  /* Annotated as a number, not the literal in the config, so the plural
     stays correct if the cutoff is ever changed to a single day. */
  const cutoffDays: number = commerce.cutoff.daysBefore;

  const neverBakes = commerce.neverBakeWeekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day));
  const bakeDays = product ? availableWeekdayNames(product) : [];
  const bakesEveryOtherDay =
    product !== null &&
    bakeDays.length === WEEKDAY_NAMES.length - neverBakes.length &&
    commerce.neverBakeWeekdays.every((day) => !product.availableOn.includes(day));

  const bakeDaysSentence = bakesEveryOtherDay
    ? `Bake days are every day except ${neverBakes.join(" and ")}, when Hakop is in class.`
    : bakeDays.length > 0
      ? `Bake days are ${bakeDays.join(", ")}.`
      : "Tuesday is never a bake day, because Hakop is in class.";

  /*
    The allergen list in running prose. The label statement is Title Case
    because the label is, and joining that form straight into a sentence puts
    six capitals in the middle of it. Lower case with an "and" is how every
    other page on this site says the same six words.
  */
  const allergenWords = (product?.allergens ?? []).map((word) => word.toLowerCase());
  const allergens =
    allergenWords.length > 1
      ? `${allergenWords.slice(0, -1).join(", ")} and ${allergenWords[allergenWords.length - 1]}`
      : (allergenWords[0] ?? "wheat, milk, egg, almonds, walnuts and sesame");

  return {
    values: {
      allergens,
      bakeDaysSentence,
      businessName: business.name,
      city: business.city,
      county: compliance.county,
      cutoffDays: String(cutoffDays),
      cutoffLabel,
      cutoffWord: cutoffDays === 1 ? "day" : "days",
      deliveryZipCount: String(DEFAULT_DELIVERY_ZIPS.length),
      homeKitchenStatement: compliance.homeKitchenStatement,
      leadDays: String(leadDays),
      leadWord: leadDays === 1 ? "day" : "days",
      operationClass: compliance.operationClass,
      owner: business.owner,
      storage:
        product?.storage ?? "Keep the tray sealed at room temperature and out of direct sun.",
    },
    flags: {
      storeOpen,
      registrationIssued: complianceIsComplete,
      registrationPending: !complianceIsComplete,
      bestByUnknown: product === null || product.bestByDays === null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The template step                                                   */
/* ------------------------------------------------------------------ */

const TOKEN = /\{(?:if:([A-Za-z][A-Za-z0-9]*)|else|end)\}/g;
const VALUE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * Resolve `{if:flag} ... {else} ... {end}`, including nested ones.
 *
 * Written as a tiny recursive reader rather than a regex, because a regex
 * cannot match a nested pair and the "When can I order" answer has one: the
 * registration sentence sits inside the store closed branch.
 */
function resolveConditionals(input: string, flags: AnswerContext["flags"], where: string): string {
  let cursor = 0;

  function block(): { text: string; closer: "else" | "end" | null } {
    let out = "";
    for (;;) {
      TOKEN.lastIndex = cursor;
      const match = TOKEN.exec(input);
      if (match === null) {
        out += input.slice(cursor);
        cursor = input.length;
        return { text: out, closer: null };
      }

      out += input.slice(cursor, match.index);
      cursor = match.index + match[0].length;

      const flag = match[1];
      if (flag === undefined) {
        return { text: out, closer: match[0] === "{else}" ? "else" : "end" };
      }

      if (!(flag in flags)) {
        throw new Error(
          `${where} tests {if:${flag}}, which is not a condition this site has. ` +
            "The allowed ones are listed in src/content.config.ts.",
        );
      }

      const taken = flags[flag] === true;
      const first = block();
      let second: { text: string; closer: "else" | "end" | null } = { text: "", closer: "end" };

      if (first.closer === "else") second = block();
      else if (first.closer !== "end") {
        throw new Error(`${where} opens {if:${flag}} and never closes it with {end}.`);
      }
      if (second.closer !== "end") {
        throw new Error(`${where} opens {if:${flag}} and never closes it with {end}.`);
      }

      out += taken ? first.text : second.text;
    }
  }

  const result = block();
  if (result.closer !== null) {
    throw new Error(`${where} has a stray {${result.closer}} with no {if:...} before it.`);
  }
  return result.text;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const escapeHtml = (value: string): string => value.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

function fillValues(
  input: string,
  values: AnswerContext["values"],
  where: string,
  escape: boolean,
): string {
  return input.replace(VALUE, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(
        `${where} names {${name}}, which is not a value this site can fill in. ` +
          "The list is buildAnswerContext in src/pages/faq/_answers.ts.",
      );
    }
    return escape ? escapeHtml(value) : value;
  });
}

/**
 * Fill a plain string: a short answer, a title, a meta description, the body
 * of a note. Values are not escaped, because Astro escapes them on output.
 */
export function fillText(input: string, ctx: AnswerContext, where: string): string {
  return fillValues(resolveConditionals(input, ctx.flags, where), ctx.values, where, false);
}

/**
 * Fill the HTML that markdown produced for an answer body.
 *
 * Markdown leaves `{name}` alone, so the placeholders survive rendering and
 * are filled here. Values are escaped, because this string goes to the page
 * with set:html. A paragraph left empty by a conditional is dropped, so an
 * answer that branches to nothing does not leave a gap behind.
 */
export function fillHtml(input: string, ctx: AnswerContext, where: string): string {
  const filled = fillValues(resolveConditionals(input, ctx.flags, where), ctx.values, where, true);
  return filled.replace(/<p>\s*<\/p>\s*/g, "");
}

/**
 * The meta description for a question, filled in and then measured.
 *
 * This is the sentence a search result shows, and it is the whole reason a
 * question is its own page, so it is worth failing a build over. Google cuts
 * a description off somewhere around 160 characters, and one under about 70
 * is usually a sign that the page was given the site default by accident.
 */
export function checkedMetaDescription(entry: FaqEntry, ctx: AnswerContext): string {
  const where = `src/content/faq/${entry.id}.md`;
  const description = fillText(entry.data.metaDescription, ctx, `${where}, metaDescription`);

  if (description.length < 60 || description.length > 175) {
    throw new Error(
      `${where} produces a meta description of ${description.length} characters. ` +
        "Aim between 60 and 175, because that is what a search result shows.\n" +
        `        ${description}`,
    );
  }
  return description;
}

/**
 * The rendered markdown for an answer, or a build error naming the file.
 *
 * `rendered` is populated by the glob loader when it reads the file. It being
 * absent means the entry was loaded some other way, and rendering a page with
 * no answer on it would be worse than stopping.
 */
export function answerHtml(entry: FaqEntry, ctx: AnswerContext): string {
  const html = entry.rendered?.html;
  if (html === undefined || html.trim() === "") {
    throw new Error(
      `src/content/faq/${entry.id}.md has no body. The body is the full answer, ` +
        "and the page is nothing without it.",
    );
  }
  return fillHtml(html, ctx, `src/content/faq/${entry.id}.md`);
}
