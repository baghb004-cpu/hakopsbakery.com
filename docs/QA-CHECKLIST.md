# QA checklist

Run this before any deploy that changes a page, and in full before Phase 1 is
signed off. Copy the file into a pull request or print it; the boxes are meant
to be ticked by a person who actually looked.

Two things fail this checklist automatically and should be run first, because
they take seconds:

```
node scripts/check-copy.mjs     # em dashes, the recipe, design tells
npm run verify                  # copy guard, type check, tests, build gate
```

---

## 1. Width matrix

Every width, every page, in both states of `PUBLIC_STORE_OPEN`. The site has to
render correctly closed and open, and closed is the state it ships in.

| Width | Represents | Checked |
| --- | --- | --- |
| 320 | The narrowest phone still in real use. The floor, not an edge case | [ ] |
| 360 | The most common Android width in the wild | [ ] |
| 390 | Current mainstream iPhone | [ ] |
| 414 | Older large iPhone, still very common | [ ] |
| 430 | Current large iPhone | [ ] |
| 768 | Tablet portrait | [ ] |
| 820 | Larger tablet portrait | [ ] |
| 1024 | Tablet landscape, and the smallest laptop | [ ] |
| 1280 | Common laptop | [ ] |
| 1440 | Larger laptop | [ ] |
| 1920 | Desktop | [ ] |

At every width:

- [ ] **Zero horizontal overflow.** Not "a little". None. Check by setting
      `document.documentElement.scrollWidth` against `clientWidth`, and by
      dragging the page sideways on a real phone.
- [ ] No element forced wider than the viewport by a `min-width`, a long
      unbroken string, a table, or an image without `max-width`.
- [ ] Tables, diagrams and code blocks scroll inside their own container, never
      by moving the page.
- [ ] Body copy stays under 80 characters per line. Use `.prose-col`.
- [ ] Tap targets are at least 44 by 44 CSS pixels and at least 8 pixels apart.
- [ ] Prices and quantities use tabular figures (`class="tabular"`) so columns
      line up and digits do not shift as they change.

---

## 2. Real devices

An emulated viewport in a desktop browser does not reproduce iOS Safari's input
zoom, the dynamic viewport unit behaviour when the address bar collapses, tap
target ergonomics, or how the photography actually reads in daylight. At least
one real iOS device and one real Android device are required before sign off.

| Device | Checked |
| --- | --- |
| A real iPhone, current iOS, Safari | [ ] |
| A real Android phone, Chrome | [ ] |
| A real tablet, either platform | [ ] |
| Hakop's own phone, because he will show the site to people on it | [ ] |

Confirm this list against the family's copy of the brief, Section 10, and
replace it with the exact devices named there if they differ.

On each real device:

- [ ] **No zoom on input focus.** Every form control is at least 16px. iOS
      Safari zooms the whole page if it is even one pixel smaller, and it does
      not zoom back out.
- [ ] No use of `100vh` anywhere. `100dvh` or `svh` only, so nothing is cut off
      or overlapped when the address bar collapses.
- [ ] Any fixed bottom bar carries `padding-bottom: env(safe-area-inset-bottom)`
      and is not sitting under the home indicator.
- [ ] Landscape works, including with the on screen keyboard open.
- [ ] The label QR page loads and is readable on cellular, quickly. This is the
      page somebody opens while standing in a kitchen worried about an allergy.

---

## 3. Zoom, type size, theme, network

- [ ] **200 percent browser zoom.** No loss of content or function. Nothing
      clipped, nothing overlapping, no horizontal scroll. WCAG 2.2 asks for
      reflow at 320 CSS pixels wide, which is the same test from the other end.
- [ ] **400 percent zoom** at 1280 wide, for reflow specifically.
- [ ] **Dynamic Type / large system font.** iOS at the largest accessibility
      size and Android at the largest font scale. Layout holds, nothing is
      truncated, nothing becomes unreachable.
- [ ] **Browser font size set to 24px** with no page zoom. Everything scales,
      because sizes are relative units and not pixels.
- [ ] **Dark mode.** The site respects the user's theme, contrast still passes,
      and the photography is not washed out or floating on the wrong ground.
- [ ] **Slow 3G, with the cache disabled.** The page is useful before it is
      finished. Text is readable before the photographs arrive, nothing jumps
      as they land (explicit width and height on every image), and no layout
      shift is caused by a font swap.
- [ ] **JavaScript disabled.** Every page that is not the cart still reads and
      still navigates. This is a static site; that should be free.
- [ ] **Print.** The bake list and the order detail print sensibly. The rest of
      the site does not have to be pretty on paper, but it must not be blank.

---

## 4. Accessibility floor, WCAG 2.2 AA

Verified, not assumed. "It looks fine" is not a result.

- [ ] Real semantic landmarks: one `header`, one `nav`, one `main`, one
      `footer`. Headings in order, one `h1` per page, no levels skipped.
- [ ] **Full keyboard operability.** Every interactive element reachable with
      Tab, in a sensible order, operable with Enter or Space. No keyboard trap.
      The cart, the fulfillment picker and the quantity control included.
- [ ] **Visible focus rings** everywhere, with enough contrast against both the
      page ground and any surface they land on. Never `outline: none` without a
      replacement that is at least as visible.
- [ ] Skip link to main content, visible when focused.
- [ ] **Contrast measured with a tool.** Text at 4.5:1, large text at 3:1, UI
      component boundaries and focus indicators at 3:1. The decorative gold
      fails AA on the page ground, which is why there is a separate token for
      the gold when it has to carry text. Check every place either is used.
- [ ] Colour is never the only carrier of meaning (sold out, error, selected).
- [ ] Every image has alt text that describes the food, or is marked decorative
      when it genuinely is. Never "image of gata".
- [ ] Every form control has a real associated label. Errors are announced,
      described in text, and tied to the field they belong to.
- [ ] **`prefers-reduced-motion` respected everywhere.** No parallax, no
      autoplay, no entrance animation that cannot be turned off.
- [ ] Target size, dragging alternatives and focus appearance checked, since
      these are the WCAG 2.2 additions people miss.
- [ ] Screen reader pass on at least one page end to end: VoiceOver on iOS or
      NVDA on Windows. The product page and the checkout flow are the two that
      matter most.
- [ ] Automated pass (axe or Lighthouse) with zero violations, treated as a
      floor and not as the test.
- [ ] Language attributes correct, including on any Armenian text.

---

## 5. Content and compliance

- [ ] The compliance line renders on every page, from configuration, with the
      county, the registration number and the home kitchen statement.
- [ ] Site ingredient and allergen text matches `docs/COMPLIANCE.md` word for
      word, which matches the printed label word for word.
- [ ] No em dash anywhere. The copy guard covers the repository, but check any
      text that arrives from outside it.
- [ ] No recipe: no quantity, ratio, timing, method, oven behaviour or yield.
- [ ] No banned design tells: no tracked out eyebrow labels, no identical
      shadowed cards, no sequence markers on things that are not sequences, no
      global fade and slide up on scroll, no arrows on button text, no middle
      dot meta strings, not that cream and terracotta palette.
- [ ] No invented biography. Only the facts in `docs/BRIEF.md` section A.
- [ ] Every TODO placeholder for copy the family has to write is still visibly
      a placeholder, and is not accidentally shipped as final text.

---

## 6. Photography

**The photographs on the site today are real product shots taken on a phone.**
They are honest and they are usable, which is why they ship. A proper half day
session is still outstanding and is the single biggest visual upgrade available
to this site, because the photography is the design.

Currently in the repository:

| Shot | File | Status |
| --- | --- | --- |
| Tray rows, macro, sesame visible | `src/assets/photos/gata-rows-wide.jpg` | Phone shot, in use as the hero |
| Same tray, portrait crop | `src/assets/photos/gata-rows-tall.jpg` | Phone shot |
| Packed tray, straight down | `src/assets/photos/gata-box-square.jpg` | Phone shot |
| Whole sheet pan | `src/assets/photos/gata-tray-full.jpg` | Phone shot |

The session the brief asks for, six shots:

1. [ ] The hero: rows on the tray, close, sesame legible, the gold of the egg
       wash carrying the frame.
2. [ ] The same subject in portrait, for phone widths and for the story page.
3. [ ] Straight down on a packed tray, square, for the shop card and for social.
4. [ ] The whole sheet pan, so the scale of a batch reads.
5. [ ] A cut piece showing the nut filling turned inside the dough, because
       that is what makes this gata the rolled and sliced kind and not a
       stamped disc.
6. [ ] The tray packaged as a customer receives it, label visible, which
       doubles as the photograph that explains what arrives.

Confirm this framing list against the family's copy of the brief, Section 10,
before booking the session.

Rules for any photograph that enters the repository:

- [ ] Explicit `width` and `height` on every `<Image>`. No exceptions.
- [ ] Alt text describes the food and what is happening in the frame.
- [ ] Served as AVIF and WebP with a JPEG fallback, at responsive sizes, which
      `astro:assets` does from the source file.
- [ ] Nothing in frame that is not true: no props implying a storefront, no
      awards, no certifications that do not exist.

---

## 7. Performance

- [ ] Lighthouse on mobile, throttled, on the home page, the product page and
      the label QR page. Record the numbers in the pull request rather than
      saying "good".
- [ ] Largest Contentful Paint is the hero photograph, and it is preloaded and
      not lazy loaded.
- [ ] Cumulative Layout Shift is effectively zero. Explicit image dimensions
      and a font strategy that does not reflow.
- [ ] JavaScript budget holds: static pages ship prefetch only (about 3 KB),
      the product page adds only the add to cart control, and React is mounted
      only in the cart, the fulfillment picker and the admin.
      `docs/ARCHITECTURE.md` section 6 is the table this is checked against.
- [ ] Fonts are self hosted, subset, and preloaded.
- [ ] `/_astro/*` and `/fonts/*` are served with a long immutable cache, and
      HTML is not.

---

## 8. Phase 1, definition of done

The sign off list. Every box ticked, by a person, before Phase 1 is called
finished. Transcribed from Section 15 of the brief; confirm against the family's
copy and add anything missing rather than editing this list down.

**The site exists and is correct**

- [ ] Live on hakopsbakery.com over HTTPS, with the apex and `www` both
      resolving and one redirecting to the other.
- [ ] Renders correctly with the store **closed**: the story, the product, the
      photography and an email capture, with no cart and no price presented as
      purchasable.
- [ ] Renders correctly with the store **open**: catalog, product page, cart,
      fulfillment picker, checkout.
- [ ] The compliance line appears on every page, driven by configuration.
- [ ] The label QR landing page `/p/{sku}` resolves, is fast on cellular, and
      shows the ingredient list, the allergen statement and the home kitchen
      statement without requiring any interaction.
- [ ] 404 page exists and is useful.
- [ ] Sitemap and robots correct. Order status pages and the admin excluded.
- [ ] Open Graph image and metadata correct on every page.

**It is safe to take money**

- [ ] `scripts/preflight.mjs` passes with the production environment set.
- [ ] Registration number present and displayed, matching the printed label.
- [ ] The browser never sends a price. Verified by editing a request by hand.
- [ ] California gate verified in all three places, including the one after
      payment. Test with an out of state address changed inside Stripe
      Checkout, and confirm the automatic refund, the email, and the admin flag.
- [ ] A real end to end test order placed with a live card, fulfilled, and
      refunded.
- [ ] Stripe webhook endpoint live, signature verified, retries handled
      idempotently.
- [ ] Order confirmation email sends and reads correctly on a phone.
- [ ] Sold out dates show as sold out in the picker, never as an error at
      payment.
- [ ] Cutoff logic correct in America/Los_Angeles, including across a daylight
      saving change.
- [ ] Tuesday is never offered as a bake day.

**Quality gates**

- [ ] Sections 1 through 7 of this checklist complete.
- [ ] `npm run verify` green.
- [ ] No console errors or warnings on any page.
- [ ] Legal pages present: privacy, terms, refunds, shipping and delivery.
- [ ] Analytics reporting, with no cookie banner required.
- [ ] Somebody who is not on this project has ordered something without being
      told how.
