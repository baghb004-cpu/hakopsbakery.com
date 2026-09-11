# Architecture

How this site is put together, and why. Read this before adding a feature.

---

## The one sentence version

The public site is static HTML with no server behind it. Four small functions
handle the things that genuinely need a server. Adding a new pastry is a form
Hakop fills in, not a code change.

---

## 1. Why the catalog is built the way it is

There is a real tension in this project and it is worth naming directly.

The brief says products live in `/src/content` as structured data. That is the
fastest possible arrangement: every product page is plain HTML, generated once,
served from a CDN edge, and it cannot be slow. But it also means that adding a
pastry requires editing a file and pushing a git commit, and Hakop is a culinary
student running a bakery, not a person who should have to learn git to add a
second product.

An admin panel that writes to a database solves that, but a site that reads its
catalog from a database at request time gives up everything that made it fast.

So the catalog is split in two, by how often each part changes.

### Tier 1: identity. Baked at build time.

Name, slug, description, ingredients, allergens, nutrition, photographs,
variants, base prices, lead time. These change rarely, in deliberate acts, and
they must be identical to the printed label.

They live in the database as the source of truth. At build time the site pulls
them and generates static pages. When Hakop publishes a change, the admin calls
a Netlify build hook, the site rebuilds in well under a minute, and the result
is still pure static HTML.

### Tier 2: availability. Read live.

Whether a bake date is sold out, how many batches are left, blackout dates,
whether the cutoff has passed. These change with every order and a stale answer
is a bad customer experience.

They are never baked into the page. The fulfillment picker calls a function and
gets the live answer. This is the one thing worth a network round trip, and it
is the specific thing the brief warns about: "Sold-out dates show as sold out in
the picker, not as a checkout error. Nothing feels cheaper than finding out at
payment."

### What this buys

- A product page is static, so it scores as well as a static page can.
- Sold-out state is never wrong, because it is never cached.
- Hakop adds a pastry in a form. He never sees a terminal.
- The catalog is versioned in the database, so a bad edit is recoverable.

---

## 2. The adapter, and why Phase 1 has no database

Supabase is not wired up yet, and it does not need to be for the store to work.

Every read of the catalog goes through one module, `src/lib/catalog-source.ts`,
which exposes a small interface. There are two implementations behind it:

- `fileSource` reads JSON from `src/content/products/`. This is what runs today.
- `supabaseSource` reads the same shape from Postgres. This is Phase 2.

The rest of the codebase cannot tell them apart, because the shape they return
is identical and is validated against the same schema either way. Switching is
one environment variable and no rewrite. That is the entire point of putting the
interface in before it is needed rather than after.

---

## 3. Why one product is modelled as many

There is exactly one product today. The catalog is still a list, the product page
is still a dynamic route, the shop index still maps over a collection, and the
cart still holds multiple lines with multiple variants.

Writing it for one product and generalising later is how you end up rebuilding
the checkout the first time a second pastry appears. The extra cost of doing it
properly now is roughly an afternoon. The cost of retrofitting it is the store
being down while it happens.

---

## 4. Stripe

Every variant of every product maps to a Stripe Price object. The variant record
carries `stripePriceId`.

The browser never sends a price. It sends a SKU, a variant id, and a quantity.
`create-checkout-session` resolves those against the catalog on the server,
looks up the Stripe Price, and builds the session from that. If someone edits
the request in their devtools, the worst they can do is buy something at the
correct price.

When a product is published from the admin, the admin creates or updates the
matching Stripe Product and Price through the Stripe API, so the two never drift
apart by hand.

Stripe Prices are immutable. Changing a price creates a new Price and archives
the old one, which conveniently gives a full price history for free.

---

## 5. The California gate

The single most important technical constraint on this site, and it is enforced
in three independent places because two of them can be bypassed.

1. **In the cart, before checkout.** The customer enters a ZIP. The
   `check-delivery-zone` function answers whether it is in California and, for
   delivery, whether it is inside the radius. Only a pass allows checkout.
2. **In the Stripe session.** `allowed_countries` is locked to US and
   `custom_text` restates that shipping is California only.
3. **In the webhook, after payment.** The final address is re-read from the
   completed session and re-validated server side. A customer can change the
   address inside Stripe Checkout after step 1 passed. If a non-California
   address comes through, the order is refunded automatically, the customer is
   emailed an explanation, and it is flagged in the admin.

Step 3 is the one that gets skipped, and it is the only one that cannot be
bypassed. It is not optional.

---

## 6. What ships JavaScript, and what does not

The default is zero.

| Page | JavaScript |
| --- | --- |
| Home, story, gata, faq, contact, all legal pages | prefetch only, about 3 KB |
| `/p/{sku}` label QR landing | prefetch only, about 3 KB |
| Product page | prefetch, plus the add to cart control |
| Cart, checkout | prefetch, plus the cart and fulfillment islands |
| Admin | React, freely. Nobody is scoring the admin. |

The header cart badge is deliberately **not** a React island. It reads a number
out of localStorage, and hydrating React to do that would put 215 KB on every
page on the site, including the label page a customer scans on cellular while
standing in a kitchen worried about an allergy. It is about four hundred bytes
of inline script instead. See `docs/DECISIONS.md` D-006.

---

## 7. Directory map

```
src/
  components/     Astro components. No client JavaScript.
  islands/        React. Only mounted where interaction is genuinely required.
  layouts/        Base.astro, the one page shell.
  pages/          Routes.
  content/        Product data. Tier 1 of the catalog.
  lib/            Logic shared between pages, islands and functions.
  config/         site.ts, the compliance and commerce configuration.
  styles/         tokens.css, then global.css. Nothing else.
  assets/         Source photography, optimised at build.
netlify/functions/
  create-checkout-session.ts
  stripe-webhook.ts
  check-delivery-zone.ts
  check-availability.ts
  admin-*.ts      Phase 2.
scripts/
  preflight.mjs   Refuses a build that would be out of compliance.
  check-copy.mjs  Refuses a commit containing an em dash or the recipe.
  fetch-fonts.mjs Run once. Output is committed.
docs/
```

---

## 8. Rules that are not negotiable

- The browser is never the authority on a price, a quantity limit, a discount,
  or delivery eligibility.
- The recipe never enters this repository. Ingredient names are public by law.
  Amounts, ratios, timings, method and yield are not. `scripts/check-copy.mjs`
  enforces this on every commit.
- The compliance footer is rendered by one component, driven by config.
  Never type a registration number into a template.
- No em dashes, in copy, code comments, or documentation.
- Every image carries an explicit width and height.
- Never `100vh`. Use `100dvh` or `svh`.
- Every form control is at least 16px, or iOS Safari zooms on focus.
