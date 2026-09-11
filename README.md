# hakopsbakery.com

The website for **Hakop's Bakery**, a Class A Cottage Food Operation in Cypress,
California, run by Hakop Baghdasarian. It sells Armenian gata, made by hand and
sold by the tray, inside California only: pickup, local delivery, and in state
shipping.

The site is a static Astro build. The public pages are plain HTML with no server
behind them. A handful of Netlify functions handle the things that genuinely
need a server: creating a Stripe Checkout session, receiving the Stripe webhook,
checking a delivery ZIP, and reading live availability.

**The store is currently closed.** There is no registration number yet, so the
site ships in its closed state: the story, the product, the photography and an
email capture, with no cart and no price presented as purchasable. Every page
has to render correctly in both states, and the build refuses to open the store
without a registration number.

---

## Start here

If you are picking this up, whether you are Hakop, Lusik, or a Claude session
opening the repository cold, read **[docs/HANDOVER.md](docs/HANDOVER.md)** first.
It says what is done, what is deliberately blank, what you do not need, and the
path from here to a first order.

Then run:

```
npm install
npm run status      # what is set, what is missing, and what each missing value unlocks
npm run dev         # the site, at http://localhost:4321
npm run verify      # the contract: copy, contrast, types, tests, build, HTML audit
```

`npm run status` is the fastest way to see how far the site is from taking a
real order. It reads only and changes nothing.

---

## The one rule that is not negotiable

**The recipe must never enter this repository.**

Ingredient **names** are legally required on the label and are therefore public:
all purpose flour, sour cream, unsalted butter, baking powder, almond flour,
walnuts, sugar, cinnamon, clove, nutmeg, egg, sesame seeds.

Quantities, ratios, timings, method, oven behaviour and yield are the actual
trade secret. They must never appear in code, comments, seed data, alt text,
documentation, a test fixture, or a commit message, and they must not be
invented either. `scripts/check-copy.mjs` blocks any commit that contains them.
Read `CONTRIBUTING.md` before your first commit.

---

## Running it on a laptop

You need Node 20.11 or later. Nothing else.

```
npm install
npm run dev
```

Then open **http://localhost:4321**.

No environment file is required to start. Everything in `src/config/site.ts`
falls back to a safe default, the store stays closed, and no analytics script
loads. To work on something that needs configuration, copy the example file and
fill in what you need:

```
cp .env.example .env
```

`.env` is ignored by git and must never be committed. `.env.example` is
committed, deliberately, as documentation.

Install the commit hook once, on a fresh clone:

```
npm run hooks:install
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Astro dev server on http://localhost:4321, with hot reload |
| `npm run build` | Runs `scripts/preflight.mjs`, then builds to `dist/` |
| `npm run preview` | Serves the built `dist/` locally, closer to production |
| `npm run check` | `astro check`: TypeScript and Astro template diagnostics |
| `npm test` | Vitest, once. `npm run test:watch` to leave it running |
| `npm run lint:copy` | The content guard on its own |
| `npm run verify` | Copy guard, type check, tests, build. Run before a push |
| `npm run hooks:install` | Points git at `.githooks`, enabling the pre-commit guard |

Two of these are gates rather than tools, and they are the reason the site
cannot quietly go out of compliance:

- **`scripts/preflight.mjs`** runs before every build. It refuses to produce a
  build with the store open while the registration number, the county, the
  business name, the Stripe secret key or the Stripe webhook secret is missing,
  and it catches a secret that has accidentally been given a `PUBLIC_` prefix.
  It fails the Netlify deploy rather than publishing a site that advertises a
  registration it does not have.
- **`scripts/check-copy.mjs`** runs on every commit through the pre-commit hook.
  It blocks em dashes and anything that looks like the recipe, and it warns
  about the design tells the client banned.

`scripts/fetch-fonts.mjs` is run once by hand. Its output is committed.

---

## Environment variables

Everything is documented in **`.env.example`**, which lists every variable, what
it is, where to get it, and whether it is safe to be public.

The short version: **anything prefixed `PUBLIC_` is compiled into the JavaScript
that every visitor downloads.** It is public, permanently, the moment it
deploys. Anything without that prefix is available only to the build and to the
Netlify functions. Never put a secret behind a `PUBLIC_` prefix; preflight tries
to catch it, but it should never get that far.

The list that must be set in Netlify before the store can open is in
`docs/LAUNCH.md` section C.

---

## Repository layout

```
src/
  assets/photos/    Source photography. Optimised at build by astro:assets.
  components/       Astro components. No client JavaScript.
  islands/          React. Mounted only where interaction is genuinely needed.
  layouts/          Base.astro, the one page shell.
  pages/            Routes.
  content/          Product data. Tier 1 of the catalog, baked at build time.
  lib/              Logic shared between pages, islands and functions.
  config/           site.ts, the compliance and commerce configuration.
  styles/           tokens.css, then global.css. Nothing else.
netlify/functions/  The four things that need a server.
scripts/            The build gate, the content guard, the font fetcher.
docs/               Read these before changing anything. Start with ARCHITECTURE.
tests/              Vitest.
```

Astro path aliases, which are configured and should be used:
`@/`, `@components/`, `@islands/`, `@layouts/`, `@lib/`, `@config/`.

---

## Documentation

| File | What it is for |
| --- | --- |
| `docs/ARCHITECTURE.md` | How the site is put together, and why. Read first |
| `docs/BRIEF.md` | The working copy of the brief, as a checklist |
| `docs/DECISIONS.md` | The decision log, newest first, and what is still open |
| `docs/COMPLIANCE.md` | The single source of truth for the regulated facts |
| `docs/QA-CHECKLIST.md` | Widths, devices, accessibility, definition of done |
| `docs/ADMIN.md` | How Hakop adds a pastry without seeing a terminal |
| `docs/LAUNCH.md` | The runbook from today to a first real order |
| `CONTRIBUTING.md` | The rules. Read it before the first commit |

---

## Stack

Astro 7 with `output: "static"`. React islands through `@astrojs/react`.
Tailwind 4, configured in the CSS first `@theme` block in
`src/styles/tokens.css`, so there is no `tailwind.config.js` and there should
not be one. TypeScript. Vitest. Zod for schema validation, shared between the
content collection and the Netlify functions so that a product is validated the
same way in both. Deployed on Netlify, DNS and analytics on Cloudflare.
