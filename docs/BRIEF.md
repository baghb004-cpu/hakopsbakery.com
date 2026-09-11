# Brief, working copy

**The original brief lives with the family.** It was written for Hakop and it
belongs to him. This file is the working copy: the same requirements restated as
a checklist an engineer can work against, keeping the original section numbers
so that a reference like "Section 4" resolves to the same thing in both
documents. `scripts/preflight.mjs` and `src/config/site.ts` both point here.

Three rules for this file:

1. Nothing is invented. Where a requirement has been turned into a concrete
   engineering check, the check is a restatement of the requirement, not a new
   one.
2. Where the original wording has not been transcribed yet, the section says so
   rather than guessing. See "Not transcribed yet" at the end.
3. If the family changes the brief, change this file in the same sitting and
   record the change in `docs/DECISIONS.md`.

---

## A. The facts the site is allowed to state

Everything on the public site has to be true, and this is the whole list of what
is known to be true. Anything outside it needs Hakop to supply it in his own
words.

**The business.** Hakop's Bakery. Owner Hakop Baghdasarian. Cypress,
California, in Orange County. Class A Cottage Food Operation, registration
pending. Sells inside California only. Pickup, local delivery, in state
shipping.

**The product.** Armenian gata, also called nazook or kata in some households.
Rolled dough with a sweet nut filling, sliced into pieces, egg washed, topped
with sesame seeds. Sold by the tray.

**Ingredient names**, which are legally required and therefore public: all
purpose flour, sour cream, unsalted butter, baking powder, almond flour,
walnuts, sugar, cinnamon, clove, nutmeg, egg, sesame seeds.

**Allergens:** Wheat, Milk, Egg, Almonds, Walnuts, Sesame.

**Hakop.** Culinary Arts Management at Cypress College, Hospitality Capstone in
progress, Fall 2026. Coursework has included Baking I, Sanitation and Safety,
Culinary Fundamentals, Garde Manger. ServSafe Food Handler certified and
ServSafe Allergens certified. Six years in food service. Currently at Panera
Bread since October 2023, across three cafes (Cypress, Anaheim, Cerritos), on
the salad and sandwich line. Before that, Anaheim Union High School District,
substitute food service assistant, 2021 to 2023, HACCP protocols and FIFO date
rotation. He has class on Tuesdays, 8am to 3pm, so Tuesday is never a bake day.

Checks:

- [ ] No employment history beyond the list above appears anywhere on the site.
- [ ] No family story, no grandmother, no village, no invented origin. The
      brief requires the family to write that themselves. Where a page needs
      that narrative, it carries a visible TODO placeholder naming what Hakop
      has to supply.
- [ ] No ingredient appears that is not on the list above, and the list on the
      site matches the printed label word for word.

---

## 3. The paperwork path

Class A covers direct sales to the end customer, which is what this business
does: pickup, local delivery, and shipping that Hakop fulfils himself. The
county of approval is Orange County.

- [ ] Registration obtained from Orange County Environmental Health before the
      store opens. Runbook in `docs/LAUNCH.md`, facts in `docs/COMPLIANCE.md`.
- [ ] Label samples submitted with the application, because the county wants
      them in the packet and the fee covers a limited number of designs.
- [ ] City of Cypress business licence and home occupation permit.
- [ ] Food processor course requirement satisfied, or confirmation in writing
      that the existing ServSafe certificate satisfies it.
- [ ] CDTFA seller's permit obtained, or confirmation in writing that this
      product mix does not need one.

---

## 4. Compliance and the label

This is the section the build script enforces. `scripts/preflight.mjs` refuses
a production build that has the store open without a registration number, and
it is a hard check in the build rather than a reminder in a document, because
that is what the brief asks for.

- [ ] The county of approval, the registration number, and the "Made in a home
      kitchen that is not inspected by the Department of Public Health"
      statement appear wherever the operation advertises, including this site.
- [ ] Those three values come from configuration, never typed into a template.
      One component, `ComplianceLine.astro`, renders them. One config file,
      `src/config/site.ts`, holds them.
- [ ] The build refuses to deploy in open mode while the registration number is
      empty. Implemented, `scripts/preflight.mjs`.
- [ ] The ingredient list and allergen statement on the site are identical to
      the printed label. `docs/COMPLIANCE.md` is the single source for that
      text.
- [ ] **The recipe never enters this repository.** Ingredient names are public
      by law. Quantities, ratios, timings, method, oven behaviour and yield are
      not, and they must never appear in code, comments, seed data, alt text,
      documentation or a commit message. Enforced by `scripts/check-copy.mjs`
      on every commit through the pre-commit hook.
- [ ] Sales are California only, enforced in three independent places. See
      Section 8 and `docs/ARCHITECTURE.md` section 5.
- [ ] The annual Class A gross sales ceiling is tracked (product revenue plus
      shipping revenue, excluding sales tax collected) and the admin warns
      before it is reached. See Section 12.

---

## 5. Environment variables

Every value that changes between a laptop, a preview deploy and production is an
environment variable, and every one of them is documented.

- [ ] `.env.example` lists every variable with what it is, where to get it, and
      whether it is safe to be public.
- [ ] Anything prefixed `PUBLIC_` is visible to every visitor, and nothing
      secret ever carries that prefix. `scripts/preflight.mjs` fails the build
      if a `PUBLIC_` variable looks like a secret key or a JWT.
- [ ] The store cannot open until the full production set is present in
      Netlify. The list is in `docs/LAUNCH.md`.

---

## 6. Design direction

The site should look like a working bakery put it up, not like a template. The
motif has to be specific to this bakery.

Banned outright by the client, and worth reading twice:

- [ ] No all caps tracked out eyebrow labels above headings.
- [ ] No identical rounded cards each carrying the same soft grey shadow.
- [ ] No "01 / 02 / 03" markers on things that are not a sequence.
- [ ] No fade and slide up entrance animation on every section as you scroll.
- [ ] No arrows appended to button text.
- [ ] No meta strings joined with middle dots.
- [ ] Not the cream, terracotta and high contrast serif combination.

Positive requirements:

- [ ] One motif, specific to this product. See `docs/DECISIONS.md` D-004: the
      sesame scatter and the shallow lean of the rows on the sheet pan, because
      Hakop's gata is the rolled and sliced kind and a stamped grid would
      decorate a product that does not exist.
- [ ] Photography is the centre of the site, and it is real photography of the
      real product.
- [ ] Colour comes from the token set in `src/styles/tokens.css`. No raw hex in
      a component.
- [ ] Soft warnings from `scripts/check-copy.mjs` are read, not ignored. It
      looks for several of the tells above.

---

## 8. The order flow

Five steps, and step 5 is the one that is usually skipped.

- [ ] The browser never sends a price. It sends a SKU, a variant id and a
      quantity, and the server resolves the price from the catalog.
- [ ] Sold out dates show as sold out in the picker, not as an error at
      payment. Availability is read live and never baked into a page.
- [ ] The customer's ZIP is checked before checkout is allowed.
- [ ] The Stripe session is locked to US addresses and restates that shipping
      is California only.
- [ ] **Step 5.** After payment, the webhook re-reads the final address from
      the completed session and re-validates it server side, because a customer
      can change the address inside Stripe Checkout after the first check
      passed. A non California address is refunded automatically, the customer
      is emailed an explanation, and the order is flagged in the admin. This
      one cannot be bypassed and is not optional.

---

## 10. Quality assurance

The device and width matrix, the zoom and type size checks, the network check
and the accessibility floor. Transcribed in full in `docs/QA-CHECKLIST.md`.

- [ ] Every width from 320 up renders with zero horizontal overflow.
- [ ] Tested on real devices, not only in a desktop emulator.
- [ ] 200 percent zoom, Dynamic Type, dark mode and slow 3G all pass.
- [ ] WCAG 2.2 AA, verified rather than assumed.

---

## 12. The back office

Hakop never sees a terminal. Adding a pastry is a form, not a code change. The
full design is `docs/ADMIN.md`.

- [ ] Add a pastry, as a wizard, with a cottage food eligibility gate that
      refuses a product he could not legally sell.
- [ ] Label preview and print ready export.
- [ ] Today's bake list, with a printable view.
- [ ] The order queue.
- [ ] Capacity settings.
- [ ] The revenue cap meter: product plus shipping, excluding tax, warning at
      70 percent and loudly at 85 percent.
- [ ] The compliance panel, with renewal reminders at 60 and 30 days.
- [ ] Discount codes.
- [ ] The customer list.

---

## 13. Language

- [ ] Armenian copy ships behind a toggle in Phase 3. The Armenian product name
      is already in the catalog. The Armenian description is deliberately
      empty: the family writes it in their own words.

---

## 15. Phase 1, definition of done

Transcribed as unchecked boxes in `docs/QA-CHECKLIST.md`, which is where the
sign off happens. In summary: the site is live on the real domain, it renders
correctly with the store closed and with the store open, it carries the
compliance line, it passes the copy guard, the build gate, the width matrix and
the accessibility floor, and a test order can be placed end to end the moment
the registration number exists.

---

## 17. Copy rules

- [ ] **No em dashes.** Anywhere: copy, code comments, documentation, alt text,
      commit messages. Use a comma, a colon, parentheses, or two sentences.
      Enforced by `scripts/check-copy.mjs`.
- [ ] Plain, warm, specific, confident. Short sentences. A working baker's
      voice, not a marketing department's.
- [ ] No exclamation marks.
- [ ] Banned words: artisanal, crafted with love, passion for baking, journey,
      nestled, elevate. Say a concrete true thing instead.
- [ ] Alt text describes the food. Never "image of gata".

---

## Phases

- **Phase 1.** The public site, the catalog, the cart and checkout, the
  compliance line, the label landing page. Ships with the store closed and
  opens the day the registration number arrives.
- **Phase 2.** The database as the source of truth and the back office, so
  Hakop adds a pastry from a form. `docs/ADMIN.md`.
- **Phase 3.** Armenian copy behind a toggle. Section 13.

---

## Open decisions

The brief ends with a numbered list of open decisions. They are tracked in
`docs/DECISIONS.md`, which is the live list. Number 1, the brand name and the
domain, is answered. Numbers 2 through 10 are not.

Two of them are already visible in the code and must not be lost:

- Open decision 5, pricing. Both tray prices in
  `src/content/products/gata.json` are placeholders carrying
  `"pricingStatus": "placeholder"`, and the store cannot open on a placeholder.
- The business address on the label and in the footer, which is a safety and
  privacy decision as much as a legal one. Tracked as D-003.

---

## Not transcribed yet

The original runs to at least 17 sections. The sections above are the ones whose
requirements have been carried across. These have not been transcribed, and the
numbers are left free so that nothing gets renumbered later: 1, 2, 7, 9, 11, 14,
16.

Whoever has the family's copy next should transcribe them here, along with the
exact wording of open decisions 2 through 10. Until then, treat a missing
section as missing, not as empty.
