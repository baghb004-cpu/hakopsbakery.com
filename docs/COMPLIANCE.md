# Compliance

**This file is the single source of truth for the regulated facts.** The
registration number, the county, the expiry, the legal business name, the
address, and the exact ingredient and allergen text that has to match the
printed label word for word.

If a value here disagrees with a value on the site, this file is right and the
site is wrong. If a value here disagrees with the printed label, stop and fix
both together, because that is the one disagreement that matters legally.

Nothing here is secret. Every value on this page is public by design. Secrets
live in the Netlify function environment.

**Last reviewed:** 2026-09-11.

---

## 1. Status at a glance

| Fact | Value | Status |
| --- | --- | --- |
| Legal business name | Hakop's Bakery | Confirmed, must match the county registration exactly |
| Owner | Hakop Baghdasarian | Confirmed |
| Operation class | Class A Cottage Food Operation | Confirmed, direct sales to the end customer only |
| County of approval | Orange County | Confirmed |
| Registration number | **PENDING** | Call Orange County Environmental Health, 714-433-6000 |
| Registration issue date | **PENDING** | Comes back with the registration |
| Registration expiry | **PENDING** | Comes back with the registration. Annual renewal |
| Business address on the label | **OPEN, see D-003** | Decision, not a lookup. Ask the county what the options are |
| City business licence | **PENDING** | City of Cypress |
| Home occupation permit | **PENDING** | City of Cypress |
| CDTFA seller's permit | **PENDING, may not be required** | See the VERIFY list below |
| Food processor course | **PENDING** | ServSafe certificates already held. See the VERIFY list |
| Annual gross sales cap | **VERIFY the current year figure** | Class A statutory ceiling, adjusted annually |
| Sales territory | California only | Confirmed, not configurable |

A `PENDING` value is stored as an empty environment variable, never as a
placeholder string. An empty value is visibly missing. A placeholder looks real
and gets printed.

---

## 2. Where the county is reached

**Orange County Health Care Agency, Environmental Health.**

- Phone: 714-433-6000
- Email: EHCottageFood@ochca.com
- Office: 1241 E. Dyer Road, Suite 120, Santa Ana, CA 92705
- Hours: Monday to Friday, 8am to 4pm

Call rather than email for anything that blocks the application. Email when you
want the answer in writing, which is most of the VERIFY list below.

Record every answer in this file with the date it was given and the name of the
person who gave it. An answer nobody wrote down has to be asked for twice.

---

## 3. The label text, word for word

Everything in this section is the authority. The site renders it from
`src/content/products/gata.json` and `src/config/site.ts`, and those two must
agree with what is printed. If you change one, change all three in the same
sitting.

### Product common name

```
Armenian Gata
```

### Ingredient statement

Ingredient **names** are legally required on the label and are therefore public.
Amounts, ratios, method and yield are not, and they never enter this
repository. Listed in label order, which is descending order of predominance:

```
INGREDIENTS: all purpose flour, sour cream, unsalted butter, baking powder,
almond flour, walnuts, sugar, cinnamon, clove, nutmeg, egg, sesame seeds
```

Sub ingredients of any purchased component (for example anything compound that
Hakop buys rather than makes) must be broken out on the label. **VERIFY** each
purchased component against its own packaging before the label goes to print.

### Allergen statement

```
CONTAINS: Wheat, Milk, Egg, Almonds, Walnuts, Sesame
```

Sesame became the ninth major allergen in United States labelling law and is
easy to leave off a template written before that. It is on this product and it is
visible in every photograph on this site.

### Home kitchen statement

The exact wording, not a paraphrase:

```
Made in a home kitchen that is not inspected by the Department of Public Health.
```

This string lives in `compliance.homeKitchenStatement` in `src/config/site.ts`
and is rendered by one component, `ComplianceLine.astro`. It carries a version
stamp (`disclosureVersion`) that is recorded alongside every customer consent,
so the wording a customer actually agreed to can be shown later. Bump the stamp
whenever the wording changes.

---

## 4. What the physical label must carry

Every item on this list appears on every tray that leaves the house.

- [ ] The words "Made in a Home Kitchen" (or the county's required variant), in
      the type size the county requires. **VERIFY the current minimum size.**
- [ ] The full home kitchen statement, exactly as printed in section 3.
- [ ] The registration number issued by the county.
- [ ] The county that issued it: Orange County.
- [ ] The business name, matching the registration exactly: Hakop's Bakery.
- [ ] The business address. **OPEN, D-003.** Ask the county what may be used.
- [ ] The product common name: Armenian Gata.
- [ ] The ingredient statement, in label order, exactly as printed in section 3.
- [ ] The allergen statement, exactly as printed in section 3.
- [ ] Net quantity of contents, in both customary and metric units.
- [ ] Nutrition labelling only if a claim is made or an exemption does not
      apply. **VERIFY.** The catalog field is deliberately null today.
- [ ] Nothing that reads as a health claim, a nutrient claim, or an organic
      claim, because each one pulls in its own rule set.

Two practical notes that cost money if they are missed:

1. **Label samples go in with the application.** The county wants to see the
   label in the packet, not after approval.
2. **The fee covers a limited number of label designs.** A wrong label, or a
   design added later, is a new fee. This is the reason the admin generates the
   label from the same record the site renders, rather than somebody editing
   artwork by hand. See `docs/ADMIN.md`, step 4 of the wizard.

---

## 5. How the site enforces this

- `src/config/site.ts` holds every regulated value, read from environment
  variables. Nothing is typed into a template.
- `complianceIsComplete` is true only when the registration number and the
  county are both present.
- `storeOpen` is true only when `PUBLIC_STORE_OPEN` is set **and**
  `complianceIsComplete` is true. Somebody flipping the flag by hand cannot
  open a store that would be advertising a number that does not exist.
- `scripts/preflight.mjs` fails the build, and therefore fails the Netlify
  deploy, if the store is open without a registration number, a county, a
  business name, a Stripe secret key or a Stripe webhook secret.
- `scripts/check-copy.mjs` fails any commit that carries the recipe.
- The California gate runs in three places, the last of which is after payment.
  `docs/ARCHITECTURE.md` section 5.

---

## 6. VERIFY list

Four things that are believed to be true, that are load bearing, and that
nobody has confirmed with the authority that decides them. Get each one in
writing, then record the answer and the date here.

1. **The current application fee.** Figures published online go stale. Ask the
   county for the current fee and what it covers, specifically how many label
   designs are included.
2. **Whether the existing ServSafe certificate satisfies the food processor
   course requirement.** Hakop holds ServSafe Food Handler and ServSafe
   Allergens. Class A requires an approved food processor course. These may or
   may not be the same thing in the county's eyes, and the answer changes the
   launch timeline. Ask the county directly and keep the reply.
3. **The current year gross sales cap figure.** The Class A ceiling is adjusted
   annually. `commerce.annualCapCents` in `src/config/site.ts` carries a working
   figure that is explicitly marked as needing verification. The meter in the
   admin is only as honest as this number. Confirm what counts toward it as
   well: product revenue plus shipping revenue, excluding sales tax collected.
4. **Whether CDTFA requires a seller's permit for this product mix.** Most cold
   bakery items sold for consumption off the premises are not taxed, but a
   seller's permit and a taxable sale are separate questions, and delivery and
   shipping charges have their own treatment. Ask CDTFA, not the county.

---

## 7. Renewal

Registration renews annually. The admin compliance panel warns at 60 days and
again at 30 days before `PUBLIC_CFO_EXPIRY`. Until the admin exists, put both
dates in a calendar the day the registration arrives.

If the registration lapses, the correct behaviour is to set
`PUBLIC_STORE_OPEN=false` and redeploy. The site returns to its closed state,
which still shows the product and the story and still captures an email address,
and it stops advertising a registration that is no longer valid.
