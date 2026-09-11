# Launch runbook

From today to a first real order. Ordered, with the long lead items first.

Two tracks run in parallel and they only meet at the end. The paperwork track is
slow, sequential, and outside anyone's control. The technical track is fast and
entirely inside it. **The paperwork is the critical path.** Start the slow items
this week, then build while they move.

**Where things stand on 2026-09-11**

- Domain bought through Cloudflare, one year term (D-001).
- The site is built and it works in its closed state: the story, the product,
  the photography and an email capture, with no cart and no price presented as
  purchasable.
- No registration number, so the store cannot open. `storeOpen` is false and
  `scripts/preflight.mjs` refuses a production build that claims otherwise.

---

## Track A: paperwork

### A0. This week, because these have the longest lead times

Everything else waits on these three. Do them first even if nothing else gets
done.

- [ ] **Ask the county the four VERIFY questions.** Phone 714-433-6000, email
      EHCottageFood@ochca.com. The list is in `docs/COMPLIANCE.md` section 6.
      The one that can move the whole timeline is whether the ServSafe
      certificates Hakop already holds satisfy the food processor course
      requirement. If they do not, a course has to be completed before the
      application is accepted, and that is measured in weeks.
- [ ] **File the fictitious business name (DBA) if one is needed.** "Hakop's
      Bakery" is not Hakop's legal name, so a DBA is very likely required.
      California requires the filed name to be published in an adjudicated
      newspaper once a week for several successive weeks, and the bank will
      want the filing before it opens an account. **VERIFY the current
      requirement and the publication period with the Orange County
      Clerk-Recorder.** This is the item that quietly adds a month.
- [ ] **Settle D-003, the business address.** It goes on the printed label and
      in the footer, and the label cannot be exported without it. Ask the county
      what options exist for a home based operation before deciding anything.

### A1. Money and identity

- [ ] Employer Identification Number, or the decision to operate on Hakop's
      social security number as a sole proprietor. Free, immediate, from the
      IRS. An EIN is worth having so the number on forms is not a personal one.
- [ ] Business bank account. Needs the DBA filing and the EIN. A separate
      account is what makes the annual cap meter in the admin trustworthy and
      makes tax season a morning rather than a week.
- [ ] Stripe account, created against the business name and the business bank
      account. Identity verification can take a few days and occasionally asks
      for documents, so do not leave it for launch week.

### A2. City of Cypress

- [ ] Business licence.
- [ ] Home occupation permit. A home based food business needs the city to
      agree that the activity is allowed at the address, and the county may ask
      to see it.
- [ ] Ask the city whether anything else applies to a cottage food operation at
      a residence, and write the answer down.

### A3. The county packet

- [ ] Complete the Class A Cottage Food Operation application from Orange County
      Environmental Health.
- [ ] **Label samples, printed, in the packet.** Generated from the record, not
      drawn by hand. `docs/COMPLIANCE.md` section 4 lists every item the label
      must carry. Remember that the fee covers a limited number of label
      designs, so get the label right before it is submitted.
- [ ] Self certification checklist, kitchen and water source questions, and any
      food safety certificate the county accepts.
- [ ] Pay the current fee. **VERIFY the figure**; do not rely on a number found
      on the internet.
- [ ] Submit, and record the submission date. Ask for the expected timeline and
      write that down too.

### A4. Tax

- [ ] Ask CDTFA whether a seller's permit is required for this product mix.
      Most cold bakery items sold for consumption off the premises are not
      taxed, but that is a different question from whether a permit is needed,
      and delivery and shipping charges have their own treatment. Get the answer
      in writing and record it in `docs/COMPLIANCE.md`.
- [ ] If a permit is required, register and set `PUBLIC_SELLERS_PERMIT`.

### A5. When the registration arrives

- [ ] Record the registration number, the issue date and the expiry in
      `docs/COMPLIANCE.md`.
- [ ] Put the renewal date, minus 60 days and minus 30 days, in a calendar.
- [ ] Print the real labels, and check them against `docs/COMPLIANCE.md` section
      3 word for word before a single tray is packed.

Not in the brief, so not a requirement here, but worth one question while the
county has the phone: ask what other small operations in the county do about
liability insurance, and whether the city asks for evidence of any.

---

## Track B: technical

Runs now, in parallel, and finishes waiting on Track A.

### B1. Netlify site

- [ ] Connect the repository. Build command `npm run build`, publish directory
      `dist`, functions directory `netlify/functions`. All of it is already in
      `netlify.toml`, so the site settings should need nothing.
- [ ] Confirm the build runs `scripts/preflight.mjs` first and that a deliberate
      bad configuration fails the deploy. Test this once, on purpose, so it is
      known to work rather than assumed.
- [ ] Deploy previews on. Previews always use test Stripe keys and always have
      `PUBLIC_STORE_OPEN=false`.

### B2. Environment variables, closed state

Enough to ship the coming soon site. See the full list in section C.

- [ ] `PUBLIC_SITE_URL`, `PUBLIC_BUSINESS_NAME`, `PUBLIC_CONTACT_EMAIL`.
- [ ] `PUBLIC_STORE_OPEN=false`.
- [ ] `PUBLIC_CF_ANALYTICS_TOKEN` once the Cloudflare Web Analytics site is
      created.

### B3. DNS

- [ ] Point hakopsbakery.com at Netlify from the Cloudflare dashboard. Apex and
      `www` both resolve, one redirects to the other, and the redirect direction
      is chosen once and kept.
- [ ] Simplest arrangement: DNS only (not proxied) for the Netlify hostname, so
      Netlify issues and renews the certificate and there is one CDN in the path
      rather than two. Cloudflare Web Analytics is a small script on the page
      and works either way, so proxying buys nothing here.
- [ ] Confirm HTTPS, HSTS, and that the apex certificate covers both names.

### B4. Stripe

- [ ] Test mode first. `STRIPE_SECRET_KEY` and
      `PUBLIC_STRIPE_PUBLISHABLE_KEY` set to test keys.
- [ ] Create the webhook endpoint pointing at the deployed
      `stripe-webhook` function. Subscribe to the checkout and payment events
      the function handles.
- [ ] Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. Without it the
      webhook cannot verify signatures, which means the California re validation
      after payment never runs, which is the one check that cannot be bypassed.
- [ ] Create the Stripe Products and Prices for both tray variants once the real
      prices exist (brief open decision 5), and store the price ids on the
      variant records. Until then the catalog carries
      `"pricingStatus": "placeholder"` and the store must stay closed.

### B5. Rehearsal, in test mode

Do all of this before the registration number arrives, so that launch day is
only a configuration change.

- [ ] Place a test order end to end: pickup, delivery and shipping, one each.
- [ ] Confirm the delivery zone check refuses an out of state ZIP in the cart.
- [ ] **Change the address inside Stripe Checkout to an out of state one after
      the cart check passed.** Confirm the webhook catches it, refunds
      automatically, emails the customer, and flags the order. This is the test
      that people skip.
- [ ] Confirm a sold out date shows as sold out in the picker and never as an
      error at payment.
- [ ] Confirm the cutoff behaves correctly in America/Los_Angeles, including
      across a daylight saving change.
- [ ] Confirm Tuesday is never offered.
- [ ] Confirm the confirmation email arrives and reads correctly on a phone.
- [ ] Run `docs/QA-CHECKLIST.md` sections 1 to 7 against the preview.

### B6. Go live

Only when Track A has produced a registration number.

1. [ ] Set the compliance variables in Netlify:
       `PUBLIC_CFO_REGISTRATION_NUMBER`, `PUBLIC_CFO_COUNTY`,
       `PUBLIC_CFO_EXPIRY`, `PUBLIC_BUSINESS_ADDRESS` (D-003), and
       `PUBLIC_SELLERS_PERMIT` if one was issued.
2. [ ] Switch Stripe to live keys, and create the live mode webhook endpoint and
       its own signing secret. Live and test webhook secrets are different; this
       is a common launch day failure.
3. [ ] Replace the placeholder prices with the real ones and confirm every
       variant carries a live Stripe price id.
4. [ ] Set `PUBLIC_STORE_OPEN=true` and deploy. The build gate passes only if
       everything above is genuinely present.
5. [ ] Run `docs/QA-CHECKLIST.md` section 8, the Phase 1 definition of done, in
       full.
6. [ ] Place one real order with a real card. Fulfil it. Then refund it, and
       confirm the refund arrives.
7. [ ] Check the compliance line on the live site against the printed label, one
       more time, side by side.
8. [ ] Tell the email capture list that the store is open.

**Rollback.** If anything is wrong after opening, set `PUBLIC_STORE_OPEN=false`
and redeploy. The site returns to its closed state, which is a complete and
honest page, and no order can be placed while the problem is fixed. That is the
whole rollback procedure, and it is why the closed state was built properly
rather than as a holding page.

---

## C. Environment variables that must be set in Netlify before the store opens

Set in the **production** deploy context. Deploy previews keep
`PUBLIC_STORE_OPEN=false` and test Stripe keys. Full descriptions, including
where each value comes from, are in `.env.example`.

**Public, and visible to every visitor**

| Variable | Value at launch |
| --- | --- |
| `PUBLIC_SITE_URL` | `https://hakopsbakery.com` |
| `PUBLIC_STORE_OPEN` | `true` |
| `PUBLIC_BUSINESS_NAME` | Exactly as registered with the county |
| `PUBLIC_BUSINESS_ADDRESS` | Settled by D-003. Must match the label |
| `PUBLIC_CFO_REGISTRATION_NUMBER` | From the county. The build fails without it |
| `PUBLIC_CFO_COUNTY` | `Orange County` |
| `PUBLIC_CFO_EXPIRY` | ISO date, drives the renewal reminders |
| `PUBLIC_SELLERS_PERMIT` | Only if CDTFA issued one |
| `PUBLIC_CONTACT_EMAIL` | The address on the site and in order email |
| `PUBLIC_CONTACT_PHONE` | Deliberately not a personal mobile |
| `PUBLIC_INSTAGRAM_HANDLE` | Optional |
| `PUBLIC_STRIPE_PUBLISHABLE_KEY` | The **live** publishable key |
| `PUBLIC_CF_ANALYTICS_TOKEN` | From Cloudflare Web Analytics |

**Secret, and never prefixed `PUBLIC_`**

| Variable | Value at launch |
| --- | --- |
| `STRIPE_SECRET_KEY` | The **live** secret key |
| `STRIPE_WEBHOOK_SECRET` | The **live mode** endpoint signing secret |
| `CFO_ANNUAL_CAP_CENTS` | The verified current year ceiling |
| `ORDER_EMAIL_API_KEY` | Transactional email vendor. Vendor still undecided |
| `NETLIFY_BUILD_HOOK_URL` | Phase 2. Lets the admin trigger a rebuild |
| `SUPABASE_URL` | Phase 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | Phase 2. Server side only, ever |
| `SUPABASE_ANON_KEY` | Phase 2. No `PUBLIC_` prefix; preflight refuses JWTs |
| `CATALOG_SOURCE` | Phase 2. `file` today, `supabase` later |

`scripts/preflight.mjs` refuses the build if the store is open and any of
`PUBLIC_CFO_REGISTRATION_NUMBER`, `PUBLIC_CFO_COUNTY`, `PUBLIC_BUSINESS_NAME`,
`STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` is missing, and it warns if the
store is open while Stripe is still in test mode. Trust the gate: if it refuses,
something on this page has not actually been done.
