# Handover

Read this first. It is the front door.

This file is written for two people: **Hakop or Lusik**, receiving a website
somebody else built, and **a fresh Claude Code session** opening this repository
cold and needing to know the state of the world before touching anything.

---

## 1. What this is, in one paragraph

A complete storefront for Hakop's Bakery, built to sell Armenian gata direct to
customers inside California under the state's Class A cottage food rules. It is
finished as software. It is not selling anything yet, because selling requires a
county registration number that nobody has applied for yet, and the site refuses
to pretend otherwise.

**Right now it is a real, publishable website in its closed state**: the story,
the product, the photography and a waiting list, with no cart and no price shown
as purchasable. That is the correct and legal thing to publish before the
registration exists, and it is worth publishing now rather than waiting.

---

## 2. The one thing to run

```
npm install
npm run status
```

`npm run status` prints exactly what is filled in, what is not, where each
missing value comes from, and what it unlocks when it arrives. It reads only and
changes nothing. Run it whenever you lose the thread.

To see the site:

```
npm run dev          # then open http://localhost:4321
```

To check everything still works before committing anything:

```
npm run verify       # copy guard, colour contrast, types, tests, build, HTML audit
```

If `npm run verify` passes, the site is in a shippable state. If it fails, it
will tell you which of the six stages failed and why.

---

## 3. What you do NOT need

This matters, because the paperwork list elsewhere in these docs is long and it
is easy to think none of it can start until all of it is done. Not true.

**None of the following is required to run, develop, deploy, or hand over this
site:**

- a DBA or fictitious business name filing
- an LLC, or any business entity at all
- a work phone number
- a PO Box or a UPS mailbox
- a CDTFA seller's permit
- a business bank account
- a Stripe account
- a Netlify account

The site builds, runs and deploys without any of them. Every one of those values
is optional in the configuration, and the pages render correctly with all of
them absent. The footer simply shows the city instead of a street address, and
the phone link is absent rather than broken.

**What you actually need to take money is three things**: the county
registration number, a Stripe account, and prices. Everything else is ordering
and convenience.

---

## 4. Where this actually stands

**Done and tested.** The storefront, the cart, the fulfillment picker, the
California gate, Stripe checkout and the webhook, all the legal pages, the
compliance footer on every page, the label QR page, 176 tests, and a verify
pipeline that enforces the rules rather than trusting anyone to remember them.

**Deliberately not done.** The admin back office (Phase 2) and the game
(Phase 3). The brief is explicit that the store must ship completely before
either is started, and it is right.

**Waiting on a person, not on code.**

| Thing | Who | Why it is blank |
| --- | --- | --- |
| Registration number | Orange County, 714-433-6000 | Nothing can be sold without it |
| Tray prices | Hakop | Marked `placeholder`, so the code refuses to sell |
| Pieces per tray | Hakop | Somebody counts a real tray. It drives capacity maths |
| Net weight | Hakop | Legally required on the printed label |
| Hakop's story | Hakop | See section 6. This was left blank on purpose |
| Real photographs | The family | The current ones are honest phone photos and they work |

---

## 5. The path from here to a first order

The short version. `docs/LAUNCH.md` has the full runbook with lead times.

1. **Publish the closed site.** Connect this repository to Netlify, deploy.
   Nothing else is needed. Hakop gets a real link to share and a waiting list
   starts collecting addresses while the paperwork moves.
2. **Call the county.** The registration has the longest lead time of anything
   here, and the DBA question can quietly add a month. Start it first.
3. **Count a tray and set prices.** Fill in `piecesPerUnit`, `netWeightGrams`,
   the prices, and change `pricingStatus` from `placeholder` to `confirmed` in
   `src/content/products/gata.json`.
4. **Open a Stripe account in Hakop's name**, create the prices, put the keys in
   Netlify.
5. **When the registration number arrives**, put it in Netlify along with the
   county and the business name, set `PUBLIC_STORE_OPEN=true`, and deploy. The
   build will refuse if anything required is missing, which is the point.
6. **Work through `docs/QA-CHECKLIST.md`** before trusting it with real money.

---

## 6. Things that were deliberately left blank, and why

Do not "finish" these without asking. They are blank on purpose and filling them
in with something plausible would be worse than leaving them empty.

**Hakop's story.** The story page carries his real credentials and a clearly
marked placeholder where his own words belong. No family story was invented: no
grandmother, no village, no origin tale. On a real business trading under his
name that would be a lie, and it is also the single most reliable sign that a
page was written by a machine. Two or three paragraphs in his own voice will be
worth more than anything that could be written for him.

**Where the recipe comes from.** It is a family recipe going into a business
under one person's name. How the family wants that credited is a conversation to
have now rather than awkwardly later. A line crediting his mother costs nothing
and is the kind of detail customers remember.

**Prices and piece counts.** Blank gets noticed. A plausible invented number
gets printed on a label.

---

## 7. If you are a Claude session picking this up

Read `docs/ARCHITECTURE.md` for how it fits together and `docs/DECISIONS.md` for
why things are the way they are. Then these, which are not preferences:

1. **No em dashes.** Anywhere. Copy, code comments, documentation, commit
   messages. Firm client preference, enforced by `scripts/check-copy.mjs` and a
   pre-commit hook.
2. **The recipe never enters this repository.** Ingredient *names* are legally
   required on the label and are therefore public. Quantities, ratios, timings,
   oven temperatures, method and yield must never appear in code, comments,
   docs, alt text, test fixtures or a commit message. The copy guard blocks
   commits that contain them.
3. **The compliance footer is a legal requirement, not a design element.** The
   county, the registration number and the "Made in a home kitchen" statement
   must appear on every page in readable text. `scripts/check-html.mjs` fails
   the build if any generated page is missing it.
4. **The California gate has five layers and only the last one counts.** The
   webhook re-validates the final address after payment and refunds anything out
   of state. Read `docs/SHIPPING.md` before touching any of it.
5. **Never trust the client** for a price, a quantity, a discount or delivery
   eligibility. The browser sends a SKU and a quantity. That is all.
6. **Do not invent facts about Hakop.** The true ones are in section 4 of
   `docs/COMPLIANCE.md` and on the story page. Anything else is fabrication on a
   real person's business.
7. **Look at it on a phone.** Not a narrow browser window. The one layout bug
   that survived every automated audit in this project was found by taking a
   screenshot at 390px and looking at it.

Run `npm run verify` before and after any change. It is the contract.

---

## 8. A note on the repository itself

The git history was rewritten once, deliberately, to remove an audit's scratch
build directory that had been committed by accident. It carried a placeholder
registration number rendered inside complete and professional-looking
compliance disclosures, across roughly eighty pages. Left in history, somebody
browsing this repository could reasonably have read it as Hakop advertising a
registration he does not hold, which for a business whose entire legal standing
is that registration is not a small thing.

It is gone, and the placeholder string itself is deliberately not repeated here,
so that searching this repository for it finds nothing at all.

If you ever build with a placeholder registration number to review the
storefront, the build gate now refuses obvious placeholders, and `.gitignore`
catches scratch build directories by wildcard rather than by name.
