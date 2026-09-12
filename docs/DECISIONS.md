# Decisions

Newest first. One entry per decision that would otherwise have to be explained
again in six months. An entry records what was decided and why, not what was
built: the code says what was built.

Add an entry when a choice closes off an obvious alternative. Do not edit an old
entry to reflect a change of mind. Write a new entry that supersedes it and say
so in both.

Status is one of **Adopted**, **Open**, or **Superseded by D-nnn**.

---

## D-011 The device sweep runs at two browser text sizes, and that is where the bugs were

**Date:** 2026-09-12 **Status:** Adopted

`scripts/check-viewports.mjs` now sweeps every width in `docs/DEVICES.md`
twice: at the browser default of 16px and at 24px, which is Chromium's
largest preset. It also gained two checks that do not need anything to clip.

**Why a second text size rather than more widths.** The matrix already had
twenty six widths and they were all clean. Adding a twenty seventh would have
found nothing, because width is the axis this site was designed against and
audited on. The browser font size is the axis nobody had turned. Every length
here that matters is in rem, and so are the six bands in `breakpoints.css`,
so turning it up moves the layout as much as turning the phone sideways does,
and it moves it in a direction no one had looked at.

It found five real defects at 150 percent, on a matrix that was green at 100:

- the home hero photograph 8px off the right hand edge at 320, because an
  implicit `auto` grid track cannot be narrower than the widest min-content
  in it and the word "Armenian" in the display face measured 226px;
- the sticky order bar reading "Armenia..." over "Not taking ...", which is
  the one line on a product page that says the store is not open;
- the footer, and with it the compliance disclosure, 40px wider than a Galaxy
  Fold cover screen, from a `minmax(11rem, 1fr)` floor that a 344px screen
  cannot honour;
- the allergen list on the product card, one word per line and spilling into
  the card's padding, from a 6.5rem label column beside whatever was left;
- every label on the bottom bar clipped by two pixels top and bottom, from a
  `line-height` under the font's own.

At 200 percent, which Android Chrome's text scaling slider reaches, it also
found the bar reading "Ho... Sh... G... Questi...".

**What that costs.** The sweep goes from about a minute to about two, inside
a `npm run verify` that already builds the site and runs 192 tests. A minute
against the class of bug above is not a close call.

**The two new checks, and why neither is the overflow check again.** The
overflow check asks whether an element reaches past the viewport, and
forgives anything inside a scroll container. Both of the failures it missed
are inside a card: text wider than the box holding it, spilling sideways in
plain sight with nothing clipping and nothing scrolling, and text cut off by
an ancestor that clips rather than scrolls. In both cases the document never
scrolls sideways, so nothing above notices. The allergen list was found by
taking a screenshot and looking at it, which is the seventh rule in the
handover, and the check exists so that the next one does not have to be.

**What is deliberately not gated.** 200 percent text on a 320px screen. The
site is clean there today, and it is checked by hand, but pinning a third
pass into every build buys less than the minute it costs, and the failures
that only appear there are ones where the honest fix is a judgement rather
than a rule.

---

## D-010 The glaze bar's cost, re-measured, and three things the review found

**Date:** 2026-09-12 **Status:** Adopted. Supersedes the measurement in D-009.

A design and engineering review of the bottom bar. The bar stays as it is:
the material is right, the filter is affordable, and the numbers below are
the evidence for the second half of that. Three defects were fixed and one
claim in D-009 was withdrawn.

### The filter costs about 0.06ms a frame, and it stays

D-009 measured frame intervals. A frame interval is quantised to the
display's 16.7ms, so it can only report whether a frame was dropped, never
what something cost inside the budget. Every variant that fits reads 16.70ms,
which is exactly what that table shows.

Re-measured with the compositor's own draw time, `DirectRenderer::DrawFrame`
out of a Chromium trace, which is where a backdrop-filter's work actually
lands. Home page, 390 by 844 at a device pixel ratio of 3, ANGLE over
SwiftShader so every pixel is rasterised on the CPU, five second scroll,
median of five runs at a 4x CPU throttle:

| | compositor draw, per frame | frames per second |
| --- | --- | --- |
| no bar at all | 0.052ms | 59.8 |
| bar, no backdrop-filter | 0.051ms | 59.6 |
| **bar, blur(16px) saturate(1.6)** | **0.114ms** | **59.8** |
| bar, blur(8px) saturate(1.6) | 0.107ms | 59.9 |
| bar, blur(28px) saturate(1.6) | 0.118ms | 59.9 |
| bar, saturate(1.6) only | 0.148ms | 59.8 |
| the same filter over the whole screen | 0.252ms | **30.6** |

At a 20x throttle the shipped bar still holds 59.3fps and the full screen
control still collapses, to 30.8. So the bar costs roughly 0.06ms of
compositor draw per frame, a third of one percent of a 60fps budget, on a
machine with no GPU at all. It stays.

**AREA, not radius, exactly as D-009 said.** The last row is the control and
it is the whole argument: the identical filter over the full viewport halves
the frame rate. This bar filters 6.6 percent of the screen.

### The claim that `saturate` is nearly free is withdrawn

D-009 reasoned that a colour matrix is cheaper than a gather. Measured,
`saturate` alone costs at least as much as blur and saturate together. The
bill is not the kernel, it is the extra render pass: any backdrop-filter at
all makes the compositor copy the backdrop into a texture and draw the
element in a pass of its own. Dropping one function from the list saves
nothing. Only dropping the property saves anything, and it is not worth
saving.

The radius is a legibility number rather than a performance one, and it was
read off the screen. With saturate and no blur, the home page h1 (33px, not
the 50px D-009 claims) is fully legible through the film and collides with
the labels. By 8px it is gone. 16px is comfortably past that and costs the
same, so it stays there.

### Three defects, found and fixed

**A phantom 48px under the footer on every phone in landscape.** The rule
that shortens the rail on short viewports had been copied out of
`breakpoints.css` complete with its `max-width: 63.9375rem`, but the bar
itself is hidden from 48rem up. Between those two numbers the bar was
`display: none` while `--glaze-bar-rail` was still 3rem, so the footer
padding and the scroll padding both reserved room for a bar that was not
there. An iPhone Pro Max in landscape is 932 by 430, which is squarely in
that gap. The width condition is now the bar's own edge, 47.9375rem.

**The current page marker read as a selected tab on a wide screen.** The
pool filled its cell, which is right on a phone, where a cell is about 80px.
In the tweener band four cells share 626px or more and a 300px pool stopped
looking like wash and started looking like desktop toolbar furniture. The
pool and the gold mark above it are now capped at 7.5rem and centred, and
they are cut to the same width as each other, so the mark reads as the lit
edge the wash ran off. Below about 520px nothing changes at all. The focus
fill deliberately keeps the full cell width, because the ring is drawn at the
cell's edges and the ring's known ground has to reach them.

**The bar disappeared in Windows High Contrast.** Everything it is painted
with is a background image, and forced colours discards those and puts
nothing back, because the bar declared no background colour to force. The
computed film came back fully transparent: four links floating over scrolling
body copy, with font weight the only surviving mark of the current page. It
now takes `Canvas` for a ground, a `CanvasText` hairline for the rim, and
repaints the current page marker in `LinkText`, so it keeps two non colour
cues in the mode that exists for people who need them.

### What was checked and found already correct

Zero layout shift on load. Zero horizontal overflow from 320px up. Targets
56 by 56 with 8px between, and 48 by 48 on a short viewport. Composited
contrast measured through the real filter chain: 7.8:1 to 11:1 over the page
and over the tray photograph, and 5.5:1 at worst over a forced black backdrop
that this site cannot actually produce. The current page survives a greyscale
render. The focus ring is reachable by keyboard and legible over a
photograph. The label QR page still contains no `script` element at all.
`prefers-reduced-transparency` and `prefers-reduced-motion` are both honoured
and both still look deliberate. The safe area inset flows from one variable
into the bar, the footer padding and the scroll padding together, verified by
standing a 34px constant in place of the `env()`.

---

## D-009 The bottom bar is glazed, not glass, and it ships no JavaScript

**Date:** 2026-09-12 **Status:** Adopted

Hakop asked for a "liquid display taskbar" with Apple's cues. What shipped is
`src/components/GlazeBar.astro`: a fixed bottom navigation on phones, hidden
from 48rem up, translucent over the page beneath it, with a specular catch
along its top edge. The Apple cues are in the behaviour. The material is not
Apple's, and that is the decision.

**Why it is egg wash and not frosted glass.** Liquid Glass is cold, neutral
and optically clean. This bakery's world is warm, baked and matte, so a pane
of frost at the foot of the page would read as somebody else's component
dropped onto it. There is exactly one glossy surface in the product: the wash
brushed over the top of the gata before it bakes. It is where the light
catches, and the gold token in `tokens.css` is called `eggwash` for that
reason. So the bar is a warm film rather than a cold pane, its highlight is
gold at the core rather than white, its top edge carries a caramel rim with
the light sitting just inside it, and the catch along that edge varies in
strength along its length, because a brush does not lay wash down evenly.
Nothing about it would look right on another company's site, which is the
test the brief sets for every motif here (see D-004).

**Zero JavaScript, and what that costs.** The bar is CSS and five anchors.
Built twice, with the component mounted and with it removed, and the two
outputs compared: the label QR page goes from 3,594 to 3,689 bytes gzipped,
and the one stylesheet every page already fetches goes from 14,420 to 15,391.
Ninety five bytes on the page, 971 on a file that is cached across the site,
and that page still contains no script element at all. The one thing zero JavaScript gave up is a cart
count on the bar: the header's badge script does `querySelector`, singular,
and the header comes first in the document, so a second element carrying that
attribute would be found second and never painted. Rather than put a script
on every page for a number that is already on screen, the bar carries the
word and the header carries the count. Changing that one `querySelector` to
`querySelectorAll` is all it would take, and the note is in the component.

**The blur was measured, not assumed.** `backdrop-filter` is the expensive
part of any material like this, and the received wisdom is to avoid it. That
wisdom is about AREA, not about radius. Scrolling the home page in Chromium
at 4x and at 20x CPU throttle, on a software rasteriser, which is harsher
than the mid range Android the brief targets:

> **The table below is superseded by D-010, and the conclusion it reaches is
> not.** The metric is a frame interval, which is quantised to the display's
> 16.7ms, so four of the five rows were always going to read 16.70ms whatever
> the filter cost. It can show that a frame was dropped. It cannot measure a
> cost that fits inside the budget, which is the question being asked. D-010
> re-measures the same variants with compositor draw times, which can, and
> arrives at the same decision on better evidence. The paragraph on
> `saturate` below is wrong and D-010 says why.

| | median frame | frames over 16.9ms, of 119 |
| --- | --- | --- |
| no bar at all | 16.70ms | 7.7 |
| bar, no backdrop-filter | 16.70ms | 8.0 |
| bar, blur(16px) and saturate | 16.70ms | 8.0 |
| bar, blur(28px) and saturate | 16.70ms | 10.0 |
| **the same blur over the whole viewport** | **33.30ms** | **75.3** |

The last row is the control, and it is the point: the identical filter over
the full screen halves the frame rate, while over a 56px strip it is lost in
the noise. The bar filters 6.6 percent of the viewport. So the blur stayed,
at 16px, which is the radius at which a 50px display heading behind the bar
stops being legible and becomes a wash of colour. Anyone raising it should
re-run the measurement rather than trust this table.

`saturate(1.6)` is doing as much work as the blur and is close to free. It is
what makes the bar take the colour of whatever is behind it, so over a
photograph of a tray it goes gold and over the page ground it stays cream.
That is the content adaptive half of the brief, and it costs a colour matrix.

**80 percent is a contrast floor, not a taste.** The film is 80 percent
opaque at the top and 86 at the bottom. Measured in the browser through the
real filter chain, against a forced black backdrop that nothing on this site
could actually produce, the labels come out at 5.37:1 and the current one at
9.12:1, and the focus ring at 5.51:1. Over the real tray photograph the range
is 6.33:1 to 9.64:1. Thinning the film further would put the quiet labels
under AA on a dark photograph, which is the specific failure the brief names.

**No ambient animation, deliberately.** A sheen that drifts on a loop repaints
a composited layer for as long as the page is open, on a phone, forever. It
would also be the kind of motion that is applied to a surface rather than
earned by an action, which is the tell the brief warns about. The bar responds
to a press and to nothing else. Under `prefers-reduced-motion` even that
stops, and under `prefers-reduced-transparency` the film goes solid while the
rim, the catch and the pool all still draw, so the fallback reads as the matte
version of the same object rather than as a broken one.

**Two things it does that the header does not, both on purpose.** It keeps
Shop in the list while the store is closed, because `/shop` is a real page in
that state: it carries the sizes, the lead time, the allergens and the waiting
list, and it says plainly that nothing can be ordered yet. And it is the one
piece of navigation placed where a thumb actually is, which matters more now
that D-008 has turned the questions page into thirteen of them.

**What it leaves open.** On a phone the header nav and this bar now offer
overlapping destinations. The bar is the better place for them, so the header
could drop to the wordmark and the cart below 48rem and give a line of
vertical space back on every page. That is a change to `SiteHeader.astro` and
it belongs to whoever owns that file.

---

## D-008 One question, one page. An anchor is not a page.

**Date:** 2026-09-12 **Status:** Adopted

The questions page and the gata explainer were each one long URL with headings
inside it. Every answer is now its own page, generated from a content
collection at `src/content/faq/` for the questions and from files under
`src/pages/gata/` for the explainer. `/faq` and `/gata` become indexes that
are still worth reading on their own.

**Why. A fragment is not an address.** `/faq#delivery` and `/faq#storage` are
the same URL to a search engine. One URL carries one title, one meta
description, one position in a result page, and one preview when somebody
pastes it into a message. Fourteen answers sharing that carried none of it:
the title said "Questions", the description described the whole page, and a
person searching "how long does gata keep" was offered the entire FAQ or
nothing.

What separate pages buy this business, concretely:

- **A title and a description written for one question.** That is the sentence
  a search result shows, and it is now the answer rather than a summary of a
  page that contains the answer. Every one of them is written per question and
  the build fails if the rendered description is not between 60 and 175
  characters, because the site default silently applied to a page is the exact
  failure this change exists to prevent.
- **An ad group can land where it promised.** Hakop already ran ads for
  another family site, so this is not theoretical. An ad for local delivery
  sending somebody to a fourteen answer page and asking them to scroll is a
  click paid for and thrown away. It now sends them to `/faq/delivery/`.
- **A position of its own.** Thirteen pages can each rank for the thing they
  answer. One page ranks once, for whatever the engine decides it is mostly
  about.
- **One link to send one customer.** Somebody asks whether it can be shipped
  to Sacramento and gets `/faq/shipping/`, not a page plus an instruction to
  scroll.
- **A breadcrumb in the result.** `Breadcrumbs.astro` emits BreadcrumbList
  structured data, which is what makes a result read
  `hakopsbakery.com > Questions > Do you ship?` instead of a bare URL.

**What this costs, and why it is worth it anyway.** Thirteen thin pages are
worse than one good page, so every answer had to be worth landing on. Two
judgements follow from that. The gata explainer split into four pages and not
six: the pronunciation and the other names are one page about the word,
because either alone is a paragraph, and a paragraph does not deserve a URL.
And "how to keep it" exists once, at `/faq/storage/`, rather than on both
sides. Two pages competing for "how long does gata keep" would split the one
thing they are both trying to win, which is the same mistake as the fragments,
made in the other direction.

**Old links.** A fragment never reaches the server, so no redirect can catch
`/faq#delivery`. Every question on the index keeps the id it had and every
card on `/gata` keeps the id of the section it replaced, so an old link still
lands on the right entry, next to the link to its page. `netlify.toml`
redirects the paths that a person might type or that genuinely moved. That
file says the same thing next to the rules, so nobody adds a fragment rule
later and wonders why it never fires.

**The copy was moved, not rewritten.** It had been through a copy audit. What
changed is what breaks when a section becomes a page: a link that used to be a
fragment, and the short summaries the two indexes needed in order to be useful
rather than a list of links. Facts held in configuration (the lead time, the
cutoff, the six allergens, the county, the home kitchen statement) stayed in
configuration: the markdown carries a named placeholder and the build fills
it in, so nothing about this change put a number into prose where it can go
stale.

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
