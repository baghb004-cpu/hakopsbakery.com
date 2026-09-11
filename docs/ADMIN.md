# The back office

How Hakop adds a pastry, runs a bake day, and stays inside the law, without
ever seeing a terminal.

This is a design document for Phase 2. Nothing here is built yet. It is written
in enough detail that it can be built in slices by somebody who was not in the
room, and so that the shape of the database does not have to be guessed at
later. Section 7 is the build order.

---

## 1. The guiding principle

Two sentences, and everything else follows from them.

**Hakop never sees a terminal.** Adding a pastry is a form. Changing a price is
a form. Nothing that he has to do in the normal running of the bakery requires
git, a deploy, a text editor, or asking somebody who knows how.

**The system refuses to let him publish something that would put him out of
compliance.** Not a warning he can click past. A refusal, with a plain language
explanation of what the rule is and what he can do instead. A cottage food
operation that sells the wrong product, or ships a tray with a label that does
not match what is inside it, has a real problem with the county, and the person
best placed to prevent that is the software, at the moment of entry, every time.

Three consequences worth stating out loud:

- Validation is not politeness. Where the law is the constraint, the button is
  disabled and the reason is written in the same words a person would use.
- Every regulated value has exactly one home. The label, the product page and
  the database all read from the same record, so they cannot disagree.
- Anything the admin does that changes what the public sees ends with a
  rebuild of the static site, automatically. He should never have to wonder
  whether the site is showing the old version.

---

## 2. Who can sign in

Small and boring on purpose. There are two or three people who will ever use
this.

- **Supabase Auth, magic link.** Hakop types his email address, gets a link,
  clicks it, and he is in. No password to forget, reset, reuse or write down.
- **Email allowlist. No public signup.** Signup is off entirely. A row has to
  exist in `admin_users` before a link will be sent, and the sign in screen says
  the same thing whether the address is unknown or the link failed, so the form
  cannot be used to find out who has access.
- **Roles.** `owner` (Hakop) and `staff` (a family member helping with orders).
  Staff can work the order queue and the bake list. Only an owner can publish a
  product, change a price, change ingredient or allergen text, or touch
  compliance settings.
- **Sessions are short and the admin is `noindex`.** It is excluded from the
  sitemap already (see `astro.config.mjs`).
- **Every write is recorded** in `audit_log` with who, what, when and the before
  and after values. This is not surveillance of a two person business; it is so
  that "when did the allergen line change and who changed it" has an answer.

One implementation constraint, worth knowing before it bites: the Supabase anon
key is a JWT, and `scripts/preflight.mjs` deliberately fails any build where a
`PUBLIC_` prefixed variable looks like a JWT or a secret key. So the admin
bundle does not read its Supabase config from a `PUBLIC_` build variable. It
fetches it from an `admin-config` function at runtime, or the admin ships as a
separate application with its own environment. The service role key never leaves
the Netlify function environment under any circumstance.

---

## 3. Add a pastry: the wizard

One task per screen, in the order a baker would actually think about it. Every
step saves a draft, so it can be abandoned at step 4 on a phone and picked up
two days later on a laptop. Nothing is visible to the public until the last
step, and the draft carries a clear "not published" state throughout.

The steps are numbered because they are a genuine sequence.

### Step 1. Basics

| Field | Notes |
| --- | --- |
| Name | The product common name. This is what goes on the label. |
| Armenian name | Optional. Stored, shown where the design calls for it. |
| Slug | Generated from the name, editable. Checked for uniqueness live. |
| Short description | One or two sentences, in the shop's voice. |
| Long description | Optional, for the product page. |

The slug field explains itself in one line ("this is the web address: /shop/gata")
so it is obvious what it does. Once a product has been published the slug is
locked, because printed labels, a QR code and other people's links point at it.
Changing it later is possible but it is a deliberate action that also creates a
redirect, not an edit.

The copy fields run the same checks the repository does: no em dash, and no
recipe. If Hakop types a quantity or a method into a description, the field says
so in plain words, right there, and explains that ingredient names are fine and
required but that amounts are his and stay his.

### Step 2. Cottage food eligibility gate

**This is the step that makes this admin worth building.** It runs before any
work is put into photographs, pricing or labels, so that a product that cannot
legally be sold is stopped in the first two minutes rather than the last.

A short questionnaire. Plain questions, yes or no, no jargon:

1. Does this need to be kept cold at any point, before, during or after the
   sale, to be safe to eat?
2. Does it have a cream filling, a custard, a mousse, a cheesecake layer, or any
   dairy filling that is not shelf stable?
3. Does it contain meat, poultry, or fish?
4. Is it canned, jarred, pickled, fermented, or acidified in any way?
5. Does it contain fresh fruit or fresh vegetables that are not fully dried?
6. Does it contain alcohol, or any cannabis or hemp derived ingredient?
7. Does it need to be frozen to reach the customer in good condition?

A disqualifying answer stops the wizard. It does not warn and continue. The
screen explains, in plain language, exactly what happened. For example:

> **This one cannot be sold under a cottage food registration.**
>
> Anything that has to be kept cold to stay safe is outside what a Class A
> cottage food operation is allowed to make and sell. That is not about your
> kitchen or your skill; it is that the law limits cottage food to items that
> are safe at room temperature, because there is no inspected cold chain behind
> them.
>
> If you want to sell this, the routes are a shared commercial kitchen with the
> right permit, or a co packer. Both are real options and both are a different
> kind of business than the one you are registered for today.
>
> Check the current state list before you rule it out: **CDPH Approved Cottage
> Foods List.**

The link goes to the CDPH cottage food page. **VERIFY the URL before shipping
the admin**, because state pages move:
`https://www.cdph.ca.gov/Programs/CEH/DFDCS/Pages/FDBPrograms/FoodSafetyProgram/CottageFood.aspx`

Two design details that matter:

- **The answers are stored** on the product record with a timestamp and the
  version of the questionnaire. If the county ever asks why a product was
  considered eligible, there is a dated answer rather than a memory.
- **The list is configuration, not code.** The approved list changes by statute.
  The questions live in a table with an effective date so that the gate can be
  updated without a deploy, and so that an older product's answers still make
  sense against the questionnaire it actually faced.

The gate is advisory about the state list and absolute about the seven
questions. It never says a product **is** approved. It says it did not hit a
known disqualifier, and it always sends the reader to the state list.

### Step 3. Ingredients and allergens

The screen that has to be exactly right, because this text is the label.

**Ingredients.** A list, in label order, which is descending order of
predominance. Drag to reorder, or move with the keyboard, because a drag only
interface is not accessible and Hakop may well be doing this on a phone. One
name per row. The form accepts names and nothing else: if a row contains a
number and a unit it is rejected with an explanation, both because amounts are
the actual trade secret and because the label does not carry them.

Purchased compound components have to be broken out into their own sub
ingredients. The form asks directly: "is this something you buy already made?"
and, if so, asks for the sub ingredients from its packaging.

**Allergens.** Checkboxes over the nine major allergens: Milk, Eggs, Fish,
Crustacean shellfish, Tree nuts, Peanuts, Wheat, Soybeans, Sesame. Tree nuts are
named individually (almonds, walnuts) because that is how they are declared.

Suggestions are derived from the ingredient names (almond flour suggests Tree
nuts and almonds; sour cream and butter suggest Milk; sesame seeds suggest
Sesame) and they are always shown as **suggestions that a person must confirm**.
Nothing is ticked automatically. A derived allergen list that is silently wrong
is worse than no help at all, and the person who knows what is in the tray is
standing right there.

The screen carries one warning permanently, not as a dismissible toast:

> This text is the label. It must match the printed label word for word. If you
> change it after labels are printed, the printed labels are wrong and have to
> be replaced.

### Step 4. Label preview and export

A live preview of the actual printed label, updating as the fields above change,
rendered from the same record the site renders from.

The preview carries, and refuses to export without:

- The business name, exactly as registered.
- The business address (see `docs/COMPLIANCE.md`, D-003, still open).
- The registration number issued by the county.
- The county of registration: Orange County.
- The product common name.
- The ingredient statement, in label order.
- The allergen statement.
- Net quantity of contents, customary and metric.
- The home kitchen statement, in the required type size, exactly as worded in
  `src/config/site.ts`.

If any of those is missing, export is disabled and the missing item is named.
A label is not a draft; a wrong one goes out on a tray.

**Export produces print ready artwork**: a vector PDF at the physical label
size with crop marks and bleed, plus a sheet layout for the label stock Hakop
actually buys, plus a flat image for the county packet.

Why this step is worth real engineering effort: **the county wants label samples
submitted with the application, and the application fee covers a limited number
of label designs.** A wrong label is not an inconvenience, it is another fee and
another wait. Generating the label from the same record that drives the site is
the only way to guarantee that the tray in somebody's hands and the page on
their phone say the same thing.

The export is recorded as a `label_revision` with a version number, the exact
text, and the date. The admin can show, later, which label revision was current
on any given date.

### Step 5. Variants and pricing

Variants are the shapes a product is sold in: half tray, full tray, and whatever
comes later. Each variant has a label, a price, pieces per unit and a net
weight.

On save, the admin talks to Stripe:

- It creates or updates the matching **Stripe Product**.
- It creates a **Stripe Price** for each variant and stores the price id on the
  variant row.
- The storefront then sends only a SKU, a variant id and a quantity at checkout.
  The server resolves the Stripe Price from that. The browser is never trusted
  with a price, so the worst a customer can do by editing a request is buy
  something at the correct price.

**Stripe Prices are immutable.** Changing a price does not edit anything: it
creates a new Price and archives the old one. That is worth explaining in the
interface in one line, because it sounds like a limitation and is actually a
feature: it means the system gets a complete, tamper evident price history for
free, and an order placed last month still points at exactly what the customer
was charged.

The screen therefore shows price history under each variant, with dates. A price
change asks for confirmation and says what it will do: "This creates a new price
of X and archives the old one. Orders already placed are unaffected."

Pricing rules the form enforces: a published product cannot carry a placeholder
price (today both tray prices in `src/content/products/gata.json` are marked
`"pricingStatus": "placeholder"`, and the store cannot open on those), and a
price of zero is rejected rather than treated as free.

### Step 6. Photography

Upload from a phone, because that is where the photographs are.

- Accepts large originals. The original is kept, untouched, as the master.
- Generates **AVIF and WebP derivatives** plus a JPEG fallback, at the
  responsive sizes the site actually uses, with width and height recorded so
  that every `<Image>` can carry explicit dimensions and nothing shifts as the
  page loads.
- Each image is tagged with a role: hero, gallery, or package.
- Drag to reorder, with a keyboard alternative.

**Alt text is a required field and it is validated.** The form rejects an empty
value, rejects anything under a handful of words, and rejects text beginning
with "image of", "photo of", "picture of" or "a photograph of", with a short
explanation: a screen reader already says it is an image, so the alt text should
say what the food looks like. It shows a good example from the existing catalog
next to the field, which teaches the pattern faster than any instruction:

> Close up of gata on the tray, the cut faces showing nut filling turned inside
> the dough, sesame seeds caught in the gold egg wash.

### Step 7. Capacity

What Hakop can actually make, which is what the fulfillment picker reads.

| Field | Notes |
| --- | --- |
| Pieces per unit | Per variant. Shown to the customer and used on the label. |
| Batches per bake day | How many of these he can make in one day. |
| Lead time in days | How far ahead an order has to be placed. |
| Bake weekdays | Which days of the week this is made on. |
| Blackout dates | Holidays, exams, travel. |

**Tuesday is switched off and locked, with the reason on screen**: Hakop has
class on Tuesdays, 8am to 3pm. He can unlock it deliberately, but the default
should never quietly let an order land on a day he is not home.

Capacity feeds the live availability read described in `docs/ARCHITECTURE.md`
section 1, tier 2. Sold out is computed from batches committed against batches
available for a date, and it shows in the picker, never as an error at payment.

### Step 8. Review and publish

One screen showing everything that is about to become public: the product page
as the customer will see it, the label as it will print, the variants and their
prices, and the eligibility answers.

The publish button is disabled, with the reason named, until:

- The eligibility gate has been passed.
- Ingredients and allergens are present and confirmed by a person.
- The label preview exports cleanly.
- Every variant has a real price and a Stripe price id.
- At least one photograph exists with valid alt text.
- Capacity is set.

Publishing then does four things, in order, and shows progress for each:

1. **Writes to the database** in a single transaction, and stamps a new version
   of the product record, so that a bad edit is recoverable.
2. **Syncs Stripe**, creating or archiving Products and Prices as needed.
3. **Calls the Netlify build hook** (`NETLIFY_BUILD_HOOK_URL`), which rebuilds
   the static site with the new product baked in.
4. **Polls the build status** and shows it in plain words: "Building", then
   "Live", with a link to the new page. Well under a minute in normal
   conditions. If the build fails, it says so, keeps the product unpublished,
   and shows the failure reason rather than a build log.

That last step is not a nicety. Without it, the honest answer to "is it on the
site yet" is "reload and see", and that is how somebody ends up publishing the
same product three times.

---

## 4. Editing a product that is already live

Editing is the same wizard, entered at any step, with three differences.

**Ingredient and allergen edits are gated.** They require an explicit
confirmation step, separate from saving, that states what is about to change,
old text next to new text, and says plainly:

> Changing this makes every printed label out of date. Labels already on trays
> will no longer match what the site says. You will need to print new labels
> before the next bake day.

Confirming creates a new `label_revision` and puts a **label out of date** flag
on the product. That flag is visible on the admin dashboard, on the product row,
and on today's bake list, and it clears only when somebody marks the new labels
as printed. It is the one piece of state in this system that deliberately nags.

**Price edits** show the Stripe consequence (new Price, old one archived) and
confirm.

**Everything else** (description, photography, sort order) saves and rebuilds
with no ceremony.

Unpublishing is available and is not a delete. The product stops appearing in
the shop, the page returns a clear "not currently available" state rather than a
404 (because printed labels and QR codes point at it), and the record and its
history stay.

---

## 5. The rest of the back office

### Today's bake list

The first thing Hakop sees when he signs in on a bake morning. Not a report: a
work list.

- Grouped by product and variant, totalled, in the order he would make them.
- Every order for that bake date, with customer name, fulfillment mode, and
  anything unusual flagged.
- **Allergen flags** on any order with a note.
- A **printable view** that is one page, large type, no navigation, no colour
  dependence, and readable at arm's length on a counter with wet hands. This is
  a genuine requirement, not a bonus: a phone locks itself, and a printed sheet
  does not.
- Items can be ticked off as made, which is what feeds the order queue.

### The order queue

Every order, newest first, filterable by status and by bake date.

- Statuses: new, confirmed, in progress, ready, fulfilled, refunded, cancelled.
- One order view showing items, fulfillment mode and address, the amount, the
  Stripe payment reference, the delivery zone result, and the full event
  history.
- **Flagged orders sit at the top.** The most important flag is an order that
  failed the California re validation after payment and was refunded
  automatically (`docs/ARCHITECTURE.md` section 5, step 3). Hakop has to be able
  to see immediately that it happened, what the address was, and that the
  customer has been emailed.
- Actions: mark ready, mark fulfilled, refund, resend the confirmation email,
  add an internal note.

### Capacity settings

The same fields as wizard step 7, editable per product, plus global blackout
dates and the order cutoff (currently 8pm, two days before a bake date, in
America/Los_Angeles). Changing capacity never invalidates an order that is
already placed; it only changes what the picker offers next.

### The revenue cap meter

A Class A cottage food operation has an annual gross sales ceiling. Going over
it is a serious problem, and the only way to not notice is to not be counting.

- Counts **product revenue plus shipping revenue**, excluding sales tax
  collected. The calculation is written on the screen so it can be checked.
- A calendar year meter with the figure, the percentage, and how much room is
  left.
- **Warns at 70 percent.** A quiet, persistent note in the dashboard.
- **Warns loudly at 85 percent.** A banner on every admin screen that cannot be
  dismissed permanently, and an email. At that point the useful conversation is
  about a commercial kitchen or a Class B operation, and it needs to start
  before the ceiling arrives, not after.
- The ceiling figure is configuration (`CFO_ANNUAL_CAP_CENTS`) because it is
  adjusted annually. It is on the VERIFY list in `docs/COMPLIANCE.md`, and the
  meter says which figure it is using and when that figure was last confirmed.

### The compliance panel

Everything in `docs/COMPLIANCE.md`, but live.

- Registration number, county, issue date, expiry.
- **Renewal reminders at 60 days and at 30 days** before expiry, in the admin
  and by email. Renewal is annual and it is exactly the kind of thing that is
  remembered the week after it lapses.
- The store open switch, with its own guard rails: it cannot be switched on
  while the registration number is empty, and the panel explains that
  `scripts/preflight.mjs` will refuse the build anyway.
- The current label revision for every product, and which ones are flagged as
  out of date.
- The VERIFY list, with a place to record the answer, the date and who gave it.

### Discount codes

- Code, type (percentage or fixed amount), value, usage limit, per customer
  limit, valid dates, which products it applies to.
- **The browser is never the authority on a discount.** The code is validated
  server side at checkout and applied through Stripe. The cart may show an
  optimistic preview; the server decides.
- Usage is visible per code, so a code that leaked is obvious.

### The customer list

- Name, email, order count, total spent, last order, fulfillment modes used.
- Search and export as CSV, for the same reason any small business wants its
  own customer list: it belongs to the business, not to a platform.
- The email capture list from the closed state of the site lives here too, kept
  separate from customers, with the date captured, so the people who waited can
  be told when the store opens.
- Deleting a customer on request is one action, and it keeps the order records
  that the law requires while removing the personal detail.

---

## 6. The data model

A sketch, not a migration. Postgres, in Supabase. Every table has `id uuid`
(primary key), `created_at timestamptz`, `updated_at timestamptz`.

**Catalog**

| Table | Columns |
| --- | --- |
| `products` | `sku` unique, `slug` unique, `name`, `name_hy`, `description`, `description_hy`, `status` (draft, published, unpublished), `sort_order`, `lead_time_days`, `available_weekdays int[]`, `storage`, `serving_suggestion`, `best_by_days`, `published_at`, `published_by` |
| `product_ingredients` | `product_id`, `position` (label order), `name`, `is_purchased_component`, `sub_ingredients text[]`. Unique on (`product_id`, `position`) |
| `product_allergens` | `product_id`, `allergen` (constrained to the nine major allergens plus a specific tree nut name), `confirmed_by`, `confirmed_at` |
| `product_variants` | `product_id`, `variant_key`, `label`, `price_cents`, `pricing_status`, `pieces_per_unit`, `net_weight_grams`, `net_weight_display`, `stripe_product_id`, `stripe_price_id`, `active` |
| `product_images` | `product_id`, `role` (hero, gallery, package), `position`, `storage_path`, `alt`, `width`, `height`, `derivatives jsonb` |
| `product_versions` | `product_id`, `version`, `snapshot jsonb`, `created_by`. Every publish writes one. This is what makes a bad edit recoverable |

**Compliance**

| Table | Columns |
| --- | --- |
| `eligibility_questionnaires` | `version`, `effective_from`, `questions jsonb` |
| `eligibility_answers` | `product_id`, `questionnaire_version`, `answers jsonb`, `result` (pass, blocked), `blocked_reason`, `answered_by`, `answered_at` |
| `label_revisions` | `product_id`, `version`, `label_text jsonb` (every field exactly as printed), `registration_number`, `business_name`, `business_address`, `exported_at`, `printed_at`, `superseded_at` |
| `compliance_settings` | single row: `registration_number`, `county`, `operation_class`, `issued_on`, `expires_on`, `sellers_permit`, `home_kitchen_statement`, `disclosure_version` |
| `verify_items` | the VERIFY list: `question`, `answer`, `answered_by`, `answered_on`, `source` |

**Operations**

| Table | Columns |
| --- | --- |
| `bake_days` | `bake_date`, `is_open`, `note`. Blackouts are rows with `is_open` false |
| `capacity` | `product_id`, `bake_date` (null means the default), `batches_available`, `batches_committed` |
| `orders` | `order_number`, `customer_id`, `status`, `fulfillment_mode`, `bake_date`, `subtotal_cents`, `shipping_cents`, `tax_cents`, `discount_cents`, `total_cents`, `stripe_session_id`, `stripe_payment_intent`, `address jsonb`, `zone_check jsonb`, `compliance_disclosure_version`, `flagged`, `flag_reason` |
| `order_items` | `order_id`, `product_id`, `variant_id`, `quantity`, `unit_price_cents`, `stripe_price_id`, `label_revision_id` (what the label said on the day) |
| `order_events` | `order_id`, `type`, `payload jsonb`, `at`. Append only |
| `customers` | `email` unique, `name`, `phone`, `marketing_opt_in`, `notes` |
| `email_captures` | `email` unique, `captured_at`, `source`, `notified_at` |
| `discount_codes` | `code` unique, `kind`, `value`, `max_uses`, `max_uses_per_customer`, `starts_on`, `ends_on`, `product_ids uuid[]`, `stripe_coupon_id`, `active` |
| `admin_users` | `email` unique, `role` (owner, staff), `invited_by`, `last_seen_at` |
| `audit_log` | `actor`, `action`, `entity`, `entity_id`, `before jsonb`, `after jsonb`, `at`. Append only |

Two notes that are easy to miss and expensive to retrofit:

- **Money is integer cents.** Never a float, anywhere, including in reporting.
- **`order_items.label_revision_id`** records which label text was current when
  that order shipped. If an ingredient question ever arises about an order from
  three months ago, the answer is a row, not a reconstruction.

### Row level security

The posture is deny by default, and it is worth being precise about it because
this database holds customer addresses.

- **RLS is enabled on every table.** No exceptions, including tables that look
  harmless. A table with RLS enabled and no policy is unreadable, which is the
  correct default.
- **The `anon` role has no access to anything.** The public site is static. It
  does not query the database from the browser at all. The one live read
  (availability) goes through a Netlify function.
- **The build reads through the service role**, server side, inside the build
  container. The service role key never appears in a `PUBLIC_` variable, never
  reaches a browser, and is rotated if it ever does.
- **Admin access is policy based**, through Supabase Auth: a policy helper
  `is_admin()` checks that `auth.email()` exists in `admin_users`, and
  `is_owner()` additionally checks the role. Catalog and compliance writes
  require `is_owner()`. Order queue and bake list reads and status writes accept
  `is_admin()`.
- **Customers never sign in.** A customer's own order is reached through a
  signed, expiring link, resolved by a function that checks the signature. There
  is no customer facing database policy to get wrong, because there is no
  customer facing database access.
- **Append only tables** (`audit_log`, `order_events`, `product_versions`) have
  insert policies and no update or delete policy, for anyone.
- Storage buckets follow the same rule: originals private, derivatives public
  read, writes owner only.

---

## 7. Build order

Built in this order, each slice useful on its own, so that work can stop after
any of them and what exists still earns its keep.

**Slice 1. Sign in and see.** Supabase Auth with the allowlist, the admin shell,
and one read only screen: the order queue, reading the orders that Phase 1 is
already writing. Value on day one: Hakop stops reading orders in the Stripe
dashboard.

**Slice 2. Today's bake list, with the printable view.** Pure read. This is the
screen he will use every bake day, so it is worth having early and worth getting
right on paper.

**Slice 3. The catalog, read only, from the database.** Migrate the one product
out of `src/content/products/gata.json` into Postgres, switch
`catalog-source.ts` to `supabaseSource` behind its environment variable, and
confirm the built site is byte for byte what it was. Nothing visible changes,
which is the point: it de risks everything that follows.

**Slice 4. Edit an existing product, and publish.** The wizard, but only in edit
mode, plus the publish pipeline (transaction, Stripe sync, build hook, status).
The riskiest machinery, exercised on a product that already exists and already
works.

**Slice 5. Add a pastry.** The full wizard, with the eligibility gate first,
because it is the step that changes what gets built rather than how.

**Slice 6. Label preview and export.** Can be built ahead of slice 5 if the
county application timeline demands it, since the county needs label samples in
the packet. It depends only on slice 3.

**Slice 7. Capacity and live availability.** Capacity settings plus the
`check-availability` function reading from them, so sold out finally means
something.

**Slice 8. Compliance panel and the revenue cap meter.** Reminders, the VERIFY
list, the cap meter. Deadline driven: the renewal reminder has to exist before
the first renewal, and the cap meter before the first busy quarter.

**Slice 9. Discount codes and the customer list.** The genuinely optional ones.
They can wait until somebody asks for them, and they should.
