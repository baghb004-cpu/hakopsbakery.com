# Decisions

Newest first. One entry per decision that would otherwise have to be explained
again in six months. An entry records what was decided and why, not what was
built: the code says what was built.

Add an entry when a choice closes off an obvious alternative. Do not edit an old
entry to reflect a change of mind. Write a new entry that supersedes it and say
so in both.

Status is one of **Adopted**, **Open**, or **Superseded by D-nnn**.

---

## D-007 Catalog: database as the source of truth, pulled at build time

**Date:** 2026-09-11 **Status:** Adopted

Product identity (name, slug, description, ingredients, allergens, photographs,
variants, base prices, lead time) lives in the database and is pulled into
static pages at build time. Live availability (sold out dates, batches left,
blackout dates, cutoff) is read at request time and never baked into a page.

**Why.** The two halves of the catalog change at completely different rates.
Identity changes rarely and in deliberate acts, and it has to match the printed
label, so it should be generated once and served from an edge. Availability
changes with every order, and a stale answer produces the exact failure the
brief calls out: finding out something is sold out at payment rather than in the
picker. Splitting the catalog by rate of change gets both properties instead of
trading one for the other. Reading the whole catalog live would give up
everything that makes the site fast; keeping the whole catalog in files would
mean Hakop needs git to add a pastry.

Full reasoning in `docs/ARCHITECTURE.md` section 1. The adapter that makes the
switch a one variable change is section 2.

---

## D-006 The header cart badge is inline script, not a React island

**Date:** 2026-09-11 **Status:** Adopted

The little number on the cart in the header reads a value out of localStorage.
It is about four hundred bytes of inline script.

**Why.** Hydrating React to render a number would put roughly 215 KB on every
page on the site, including the label page that somebody scans on cellular while
standing in a kitchen worried about an allergy. React is used where interaction
is genuinely required (the cart, the fulfillment picker, the admin) and nowhere
else.

---

## D-005 Framework: Astro 7 static, not Next.js

**Date:** 2026-09-11 **Status:** Adopted

**Why.** Roughly 80 percent of this site is static content with three small
interactive pockets. The Next App Router ships a React runtime to every page,
including that label QR page. Astro ships zero JavaScript by default and lets
React be mounted only where it earns its place, which is exactly the shape of
this project.

The React knowledge still applies, because the interactive parts are React
islands written as ordinary React components. If the admin is easier to build as
a separate React application later, it can be, and nothing on the public site
has to change.

---

## D-004 Design motif: the sesame scatter and the lean of the rows

**Date:** 2026-09-11 **Status:** Adopted, and Hakop can overrule it

The motif is the hand scattered sesame and the shallow lean of the rows on the
sheet pan. Not the stamped grid the brief originally specified.

**Why.** Hakop's gata is the rolled and sliced kind: a log of nut filling turned
inside dough, cut into pieces, egg washed, scattered with sesame. It is not a
stamped disc. A stamp motif would decorate a product that does not exist, and
the brief's own principle is that the motif must be specific to this bakery.

This is the one decision in this file that contradicts the brief on purpose, so
it is flagged rather than buried. If Hakop wants the stamp, he gets the stamp.

---

## D-003 Business address on the label and in the footer

**Date:** 2026-09-11 **Status:** OPEN. Blocking the label, not blocking the site

Publishing a home address is a real safety and privacy decision, and it applies
to the printed label as much as to the footer, so it cannot be decided by
whoever builds the footer.

**What has been done in the meantime.** `business.address` in
`src/config/site.ts` is empty and the footer shows the city only. Nothing
anywhere assumes a street address exists.

**Next action.** Ask Orange County Environmental Health what the options are:
phone 714-433-6000, email EHCottageFood@ochca.com. Record the answer in
`docs/COMPLIANCE.md`, which is where the label text lives.

---

## D-002 Analytics: Cloudflare Web Analytics, not Google Analytics

**Date:** 2026-09-11 **Status:** Adopted

**Why.** About 1 KB versus about 45 KB. No cookies, which means no consent
banner and a short privacy policy. The domain is already on Cloudflare, so it
adds no new vendor and no new data processor to disclose. Google Analytics would
cost real Lighthouse points on the pages that most need to be fast, and it would
buy a bakery selling one product nothing it would ever act on.

Configured through `PUBLIC_CF_ANALYTICS_TOKEN`. Absent token means no analytics
script at all, which is the correct behaviour on a laptop and in a preview
deploy.

---

## D-001 Brand name and domain: Hakop's Bakery, hakopsbakery.com

**Date:** 2026-09-11 **Status:** Adopted

Domain bought through Cloudflare on a one year term.

**Why it was decided first.** The name is an input to four other things that all
have lead time: the county application, the city licence, the Stripe account,
and the printed labels. None of them can start until the name is fixed, and
changing it afterwards means doing all four again. Buying the domain at the same
time removes the risk of the name being fixed on paper and unavailable on the
web.

---

# Still open

The brief ends with a numbered list of open decisions. Number 1, the brand name
and the domain, is answered above as D-001. Numbers 2 through 10 are not
answered, and they are listed here by their brief numbers so that nothing is
silently forgotten.

The wording of most of them has not been transcribed into this repository yet.
Where the repository already evidences the question, the subject is filled in
and cited. Where it does not, the row says so. Do not renumber these rows and do
not merge them into the D-nnn series: the two numbering schemes are separate,
and `src/content/products/gata.json` already cites a brief number.

| Brief | Subject | Status | Evidence in the repo |
| --- | --- | --- | --- |
| 2 | Not transcribed | Unanswered | |
| 3 | Not transcribed | Unanswered | |
| 4 | Not transcribed | Unanswered | |
| 5 | Pricing for both tray sizes | Unanswered, and blocking the store opening | `src/content/products/gata.json`, both variants carry `"pricingStatus": "placeholder"` |
| 6 | Not transcribed | Unanswered | |
| 7 | Not transcribed | Unanswered | |
| 8 | Not transcribed | Unanswered | |
| 9 | Not transcribed | Unanswered | |
| 10 | Not transcribed | Unanswered | |

Also open, and tracked in this file rather than in the brief's list:

- **D-003, the business address.** See above.
- **The contact phone number.** `src/config/site.ts` says the published number
  is deliberately not Hakop's personal mobile, and cites "DECISIONS.md D-010"
  for the reasoning. No D-010 exists in this log. Either that entry gets written
  when the number is chosen, or the citation in `site.ts` is corrected. Whoever
  owns `src/config/site.ts` should settle it; it is a one line comment fix.
- **The transactional email vendor.** The webhook has to email a customer whose
  order was refunded for a non California address (Section 8, step 5), so a
  sending vendor is required before the store opens. None is chosen.
  `.env.example` carries the variable with the vendor marked PENDING.

Anything transcribed from the family's copy should land here first, then be
answered as a D-nnn entry above when it is decided.
