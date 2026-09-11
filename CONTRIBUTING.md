# Contributing

This is a real business, and the site is subject to real law. Most of the rules
below exist because breaking one of them costs Hakop money, time, or a
conversation with the county. Read this before your first commit.

---

# THE RECIPE NEVER ENTERS THIS REPOSITORY

**This is the most important rule in the project. It has no exceptions.**

Hakop's gata recipe is his. It is the thing that is actually worth something,
and this repository is public infrastructure that will be read by contractors,
future maintainers, deploy logs, and anyone who ever gets a copy of the git
history. Once something is committed it is in the history, and removing it later
means rewriting history and hoping nobody cloned it first.

### Never commit any of this

- Quantities or weights of anything.
- Ratios or proportions, including phrases like "twice as much" or "equal
  parts".
- Timings of any kind: resting, chilling, mixing, baking.
- Oven temperatures, oven positions, or anything about how the oven behaves.
- Method, technique, sequence of operations, or how the dough is handled.
- Yield: how many pieces come from a batch, or how much a batch makes.
- Anything you worked out yourself and think is probably right. **Do not invent
  the recipe either.** A guess on a real business's website is worse than a
  gap, because it is wrong and it looks authoritative.

This applies everywhere, without exception: source code, comments, JSON and seed
data, test fixtures, alt text, page copy, documentation, pull request
descriptions, and **commit messages**.

### Ingredient names are fine, and are legally required

The label must carry the ingredient list, so the names are public by law and
belong in the catalog data:

> all purpose flour, sour cream, unsalted butter, baking powder, almond flour,
> walnuts, sugar, cinnamon, clove, nutmeg, egg, sesame seeds

Names, in label order, and nothing else. The line between "what is in it" and
"how it is made" is exactly the line between what the law requires to be public
and what stays in the kitchen.

The allergen statement is the same kind of thing, and is equally required:

> Wheat, Milk, Egg, Almonds, Walnuts, Sesame

Both strings have to match the printed label word for word.
`docs/COMPLIANCE.md` is the single source of truth for them.

### This is enforced automatically

`scripts/check-copy.mjs` runs on **every commit** through the pre-commit hook.
It looks for an ingredient name sitting near an amount, for method language, and
for a temperature sitting near a time, and it refuses the commit if it finds
one. It also blocks em dashes, and warns about the design tells the client
banned.

**Install the hook on a fresh clone:**

```
npm run hooks:install
```

That is all it does: `git config core.hooksPath .githooks`. `npm install` tries
to run it for you through the `prepare` script, but check that it took, because
a hook that is not installed is a guard that is not running.

Run it by hand any time:

```
node scripts/check-copy.mjs
```

If it blocks something that is genuinely not the recipe (a package net weight,
for instance), the message tells you how to mark that line. Use the opt out
sparingly and only when you are certain, and never on anything that came out of
the kitchen.

**If the recipe does get committed:** stop, do not push, and say so immediately.
An unpushed commit can be amended or reset. A pushed one needs the history
rewritten and the branch force pushed, and everyone with a clone has to be told.
Speed matters much more than embarrassment here.

---

## No em dashes

Anywhere. Copy, code comments, documentation, alt text, commit messages, pull
request descriptions.

Use a comma, a colon, parentheses, or two shorter sentences. This is a firm
client preference, it is in the brief twice, and `scripts/check-copy.mjs`
enforces it as a hard failure.

---

## Files that already have an owner

Do not edit these without talking to whoever owns them. If you genuinely need a
change, say what you need and why, in the pull request:

```
package.json  astro.config.mjs  tsconfig.json  netlify.toml
src/styles/tokens.css  src/styles/global.css  src/styles/fonts.css
src/config/site.ts
src/layouts/Base.astro
src/components/SiteHeader.astro  SiteFooter.astro  ComplianceLine.astro
  SeedRule.astro  Button.astro
src/lib/cart.ts  src/lib/fonts.ts
scripts/*.mjs
docs/ARCHITECTURE.md
```

---

## Before you open a pull request

```
npm run verify
```

That runs the copy guard, the type check, the tests and the build gate. All four
have to pass. Then work through the parts of `docs/QA-CHECKLIST.md` that your
change touches, and say in the pull request which ones you actually checked.

---

## House rules

**Compliance**

- Never type a registration number, a county or the home kitchen statement into
  a template. They come from `src/config/site.ts` and are rendered by
  `ComplianceLine.astro`. One source, one component.
- Every page must render correctly with the store **closed** and with the store
  **open**. Closed is the state it ships in today. When closed: no cart, no
  price presented as purchasable, show the story and the email capture.
- Only the facts in `docs/BRIEF.md` section A may appear on the site. No
  invented biography, no family story, no grandmother, no village. Where a page
  needs that narrative, leave a visible TODO saying Hakop must supply it in his
  own words.

**Correctness**

- The browser is never the authority on a price, a quantity limit, a discount,
  or delivery eligibility. The server resolves all four.
- Money is integer cents. Never a float.

**Design**

- Use the tokens in `src/styles/tokens.css`. No raw hex in a component.
- The decorative gold fails AA on the page ground. There is a separate token for
  the gold when it has to carry text. Use the right one.
- The motif is the sesame scatter and the shallow lean of the rows on the sheet
  pan. Not a stamped grid. `docs/DECISIONS.md` D-004 explains why.
- None of the banned tells: no all caps tracked out eyebrow labels, no identical
  rounded cards with the same soft grey shadow, no sequence markers on things
  that are not sequences, no global fade and slide up on scroll, no arrows
  appended to button text, no meta strings joined with middle dots, and not the
  cream and terracotta palette.

**Responsive and accessible, all non negotiable**

- Never `100vh`. Use `100dvh` or `svh`.
- Every form control at least 16px, or iOS Safari zooms the page on focus and
  does not zoom back.
- `padding-bottom: env(safe-area-inset-bottom)` on any fixed bottom bar.
- Tap targets at least 44 by 44 CSS pixels, at least 8 pixels apart.
- Zero horizontal overflow at any width from 320 up.
- Explicit `width` and `height` on every image.
- Body copy under 80 characters per line. Use `.prose-col`.
- Tabular figures on prices and quantities: `class="tabular"`.
- WCAG 2.2 AA, verified rather than assumed. Real landmarks, visible focus
  rings, full keyboard operability, measured contrast.
- Respect `prefers-reduced-motion` everywhere.

**Copy**

- Plain, warm, specific, confident. Short sentences. A working baker's voice,
  not a marketing department's.
- No exclamation marks.
- Banned words: artisanal, crafted with love, passion for baking, journey,
  nestled, elevate. Say a concrete true thing instead.
- Alt text describes the food and what is happening in the frame. Never "image
  of gata".

---

## Commits

- Present tense, and say what changed and why, not what file you touched.
- No em dashes, and no recipe, in the message either. The hook reads the working
  tree, not the message, so the message is on you.
- Small commits. This repository will be read by somebody who was not here.
