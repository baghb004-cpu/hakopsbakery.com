# Shipping, delivery, and the California limit

How this site makes sure food only goes where it is legally allowed to go, and
how it decides which carrier can actually get it there while it is still good.

---

## 1. The thing to get right first

"California only" has two possible meanings and only one of them is the law.

**Where the food goes must be California.** This is absolute. A Class A cottage
food operation may sell direct to the end customer, and interstate shipping is
prohibited outright. Getting this wrong is a compliance failure, not a bug.

**Who may look at the website is not restricted at all.** There is no rule
anywhere that says a person outside California cannot read the page.

So the gate is on the **destination address**, never on the visitor.

### Why we deliberately do not geo-block by IP address

It is the obvious first idea and it is wrong in four separate ways.

1. **It would cost real, legal sales.** Someone in New York ordering gata to be
   shipped to their sister in Fresno is a completely lawful sale. The food never
   leaves the state. Blocking the buyer by location turns away money for no
   legal reason.
2. **It would wreck search ranking.** Googlebot does not crawl from California.
   An IP gate serves it a refusal, the site drops out of the index, and the
   performance work becomes pointless because nobody arrives to see it.
3. **It breaks for actual Californians.** A customer on holiday in Las Vegas,
   or on a phone routed through a carrier gateway in another state, or behind a
   corporate VPN, gets locked out of their own local bakery.
4. **It does not even work.** Any VPN defeats it in about ten seconds, so it
   provides the feeling of compliance without the fact of it, which is the worst
   possible combination.

The address gate has none of those problems and is strictly more correct.

---

## 2. Five layers, and why there are five

Each layer can be bypassed except the last one. That is the point.

| # | Where | What it checks | Can a customer get around it? |
| --- | --- | --- | --- |
| 1 | The page | Shipping is only offered as an option at all when the catalog allows it | Yes, it is only markup |
| 2 | The cart, in the browser | ZIP looks like a California ZIP | Yes, it is client side |
| 3 | `check-delivery-zone` function | ZIP validated on the server before checkout can open | Not directly, but it runs before the address exists |
| 4 | The Stripe session | `allowed_countries` locked to US, `custom_text` restates the limit | Partly. The customer can still edit the address inside Checkout |
| 5 | **The webhook, after payment** | **The final structured address is re-validated server side** | **No** |

**Layer 5 is the only one that actually closes the door**, because it runs after
the customer has stopped being able to change anything. The brief says this is
the step that gets skipped. It is not optional here, and
`src/lib/carriers.ts` exists largely to make it correct.

If layer 5 refuses an order: the order is not fulfilled, Stripe refunds it
automatically, the customer gets a clear email explaining that cottage food law
does not permit the sale, and it is flagged in the admin so Hakop knows.

### The ZIP is for the customer. The state field is for the law.

This distinction is worth stating plainly because it drives the code.

A **ZIP code** is what someone types into a box in the cart before a real
address exists. It is a helpful early answer, and a ZIP range check is a good
enough way to say "we cannot ship there" before anyone wastes time.

A **two letter state code** collected by Stripe as part of a structured address
is an authoritative field. It is not inferred from a number.

So layer 5 checks the state field first and treats the ZIP as corroboration. If
the two disagree, the order is refused rather than resolved in either direction,
because a mismatch means either a typo or somebody testing the gate, and neither
of those should be quietly fulfilled.

One specific trap is handled explicitly: **`CA` is both California and Canada.**
As a state code it means California. As an ISO country code it means Canada. The
country is checked before the state so a Canadian address can never slip through
on the strength of matching two letters. There is a test for exactly this.

---

## 3. Carrier rules that are real constraints, not preferences

These are properties of the carrier networks. No amount of configuration
changes them.

| | USPS | UPS | FedEx |
| --- | --- | --- | --- |
| PO Box | **Yes** | **No** | **No** |
| APO, FPO, DPO | Yes | No | No |
| Saturday delivery | Yes | Modelled as no | Home Delivery yes, Ground no |
| Monday delivery | Yes | Yes | Home Delivery **no** |
| Weight ceiling | 70 lb | 150 lb | 150 lb |
| In state transit | 1 to 3 business days | 1 to 2 | 1 to 2 |

The PO Box rule is the one that bites in practice. **UPS and FedEx cannot
deliver to a PO Box at all.** If a customer enters one and the site quietly
offers UPS, the shipment fails after the money has been taken. So the address
form is detected up front and the impossible carriers are removed from the
options, with the reason shown rather than the choice silently disappearing.

Two further details the code handles that are easy to miss:

- **FedEx Home Delivery runs Tuesday to Saturday.** It does not deliver on
  Mondays. A parcel that finishes transit on a Monday sits until Tuesday, and
  a naive transit calculation would promise the Monday.
- **Freight movement and delivery are two different calendars.** Ground freight
  moves Monday to Friday and never on a federal holiday. Delivery happens on
  whichever days that particular service runs. Conflating them is the classic
  bug, so `arrivalDate()` walks the two separately.

Federal holidays are listed explicitly in `src/lib/carriers.ts` through 2027
rather than computed, because the observed date of a holiday landing on a
weekend is a rule about rules, and getting it subtly wrong means promising a
delivery that cannot happen.

---

## 4. The constraint nobody builds: freshness

Every shipping calculator on the internet answers "when does it arrive". For a
bakery that is the wrong question. The right question is **"does it arrive while
it is still good"**.

So the freshness clock starts **when it comes out of the oven**, not when the
carrier collects it. A tray baked on a Friday is not collected until Monday,
because nothing moves over a weekend, and those three days count.

```
bake date  ->  ship date  ->  worst case arrival
   |                                   |
   +------------- must be within ------+
              bestByDays minus marginDays
```

If a service cannot get the box there inside that window, **it is not offered at
all**. The customer never sees an option that would deliver something past its
best. The refusal is explicit in the quote result so the page can say why.

`marginDays` exists so a box does not land on its final good morning. One day of
headroom is thin, two is kind. It is configuration, not a constant.

This is also why shipping is best offered on bake days early in the week. A
Thursday or Friday bake spends the weekend in a building.

---

## 5. What Hakop actually has to do

Nothing exotic. This is the useful consequence of cottage food law.

Cottage food forbids anything that needs refrigeration: no cream fillings, no
custards, no cheesecake, nothing acidified. **So everything he is legally allowed
to sell is, by definition, shelf stable.** Shelf stable baked goods are ordinary
parcels to all three carriers.

- No permit to ship food.
- No dry ice, no cold chain, no perishable surcharge.
- No special carrier account type.
- A retail counter account with any of the three is enough to start.

Practical notes for the kitchen:

- Pack so nothing shifts. Carriers will not cover damage they consider poor
  packing, and perishables are usually shipped at the shipper's risk with no
  declared value coverage.
- Seal against grease migration. A butter pastry marks a box.
- Put the label with the allergen line on the **product**, not just the outer
  carton, because the carton gets thrown away.
- Ship Monday to Wednesday wherever possible.

---

## 6. Local delivery and pickup

Both sit outside the carrier question entirely.

**Pickup** does not involve an address at all, so there is nothing to validate
beyond the pickup slot. It is also the cheapest and freshest option and should
be presented first.

**Local delivery** is a short list of ZIP codes Hakop can reasonably drive
around in an afternoon, with a flat fee and a minimum order. The list lives in
configuration, not in code. The starting set covers Cypress and the towns around
it, and Hakop must confirm it before launch. See open decision 4.

---

## 7. What is not built yet, stated plainly

So nobody assumes these exist.

- **Live carrier rates.** Rates are flat and configured. Real time rating needs
  carrier API credentials and is a Phase 2 item. The code is shaped so a rate
  provider drops in behind the quote function without the pages changing.
- **USPS address verification.** Right now a ZIP is validated by range and the
  state by its field. A real address verification call would additionally
  confirm the address is deliverable, return the canonical form, and flag
  residential versus commercial, which would let FedEx Home Delivery and FedEx
  Ground be chosen correctly rather than assumed. `quoteShipping` already
  accepts `destinationType` for exactly this.
- **Label purchase and tracking numbers.** Buying postage through an API and
  emailing tracking is Phase 2. Today Hakop buys postage the normal way and the
  admin records the tracking number by hand.
- **Signature on delivery, and insurance.** Not modelled. Worth revisiting only
  if a box goes missing.

---

## 8. Where the code lives

| File | Responsibility |
| --- | --- |
| `src/lib/california.ts` | Is this ZIP in California? Used everywhere, early and often. |
| `src/lib/carriers.ts` | Address form, the legal destination gate, carrier rules, the calendar, freshness, quoting. |
| `src/lib/zones.ts` | Pickup, local delivery radius, which mode is allowed. |
| `netlify/functions/check-delivery-zone.ts` | Layer 3. |
| `netlify/functions/stripe-webhook.ts` | Layer 5, the one that matters. |
| `tests/carriers.test.ts` | Proves all of the above, including the Canada trap. |
