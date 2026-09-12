# Devices, viewports and the fold

The real numbers this site's layout is built against. Every figure here is a
**CSS pixel** width, which is what a media query sees, not a hardware pixel.
Confusing the two is the most common reason a "tested" layout breaks on a real
phone.

Checked September 2026. Re-check when a new device lands.

---

## 1. The short version

Three numbers changed how this site is laid out:

- **344px.** The narrowest real device still in use, the older Galaxy Fold
  cover screen. Nothing may overflow here.
- **466px.** The iPhone Duo folded. Wider than any normal phone, and only
  678px tall. Short and wide, where every phone assumption says tall and narrow.
- **626px.** The iPhone Duo unfolded. A 7.6 inch screen that lands *below* the
  usual 768px tablet breakpoint, so a naive site serves a phone layout to a
  tablet-sized display.

That last one is the interesting failure, and it is why this site does not use
a stock breakpoint set.

---

## 2. Phones, portrait

| Device | CSS viewport | Ratio | Note |
| --- | --- | --- | --- |
| Galaxy Fold, cover (2019) | 344 x 882 | 1:2.56 | The narrowest thing still worth supporting |
| Galaxy S series | 360 x 800 | 1:2.22 | The most common Android width worldwide |
| iPhone SE | 375 x 667 | 1:1.78 | The narrowest current iPhone |
| Galaxy S Ultra | 384 x 824 | 1:2.15 | |
| iPhone 13 to 16 | 390 x 844 | 1:2.16 | The reference phone |
| iPhone 16 Pro | 402 x 874 | 1:2.17 | |
| Pixel 9, Pixel 10 | 412 x 915 | 1:2.22 | |
| iPhone Pro Max | 430 x 932 | 1:2.17 | |
| Galaxy Z Fold 7, cover | ~452 x 1000 | ~1:2.2 | 21:9, very tall |
| **iPhone Duo, folded** | **466 x 678** | **1:1.45** | **See section 4** |

## 3. Unfolded and tablets

| Device | CSS viewport | Note |
| --- | --- | --- |
| **iPhone Duo, unfolded** | **626 x 890** | 7.6 inch, below every stock tablet breakpoint |
| Galaxy Z Fold 7, unfolded | ~883 x 800 | Nearly square |
| iPad mini | 744 x 1133 | |
| Galaxy Tab S9 | 800 x 1280 | |
| iPad 10.9 | 820 x 1180 | |
| iPad Pro 11 | 834 x 1194 | |
| iPad Pro 13 | 1024 x 1366 | |

---

## 4. The iPhone Duo, and why it breaks ordinary breakpoints

Announced 9 September 2026. Inner display 7.6 inch at 1878 x 2670 hardware
pixels, 430 ppi. Outer display 5.4 inch at 1398 x 2034, 460 ppi. Both run at
3x, which gives the CSS viewports above.

Apple matched the aspect ratio across the two displays deliberately, so content
scales naturally when you open the device. That is good for apps and awkward
for the web, for two reasons.

**Folded, it is the wrong shape.** At 466 x 678 the cover screen is 1:1.45.
Every other phone is close to 1:2.2. So it is *wider and much shorter* than any
phone a layout was tested on. Anything sized to the height of a tall phone, a
hero especially, has 25 percent less vertical room than it expects while
having more horizontal room than it expects.

**Unfolded, it falls in a dead zone.** 626px is bigger than any phone and
smaller than any tablet. A stock breakpoint set jumps from a phone layout to a
tablet layout somewhere around 768px, so a 7.6 inch screen gets single column
phone styling with enormous margins. The Galaxy Z Fold 7 unfolded, at roughly
883px, sits in the same gap from the other side.

**And Safari cannot tell you it folded.** The web standard for this, CSS
Viewport Segments, is implemented in Chrome and Edge but not Safari. So the
first foldable running Safari ships without the API designed for foldables.

The consequence for this codebase: **the fold cannot be detected, so it is
never detected.** Layout responds to width and shape only. Where the viewport
segments API exists it is used as an enhancement to avoid placing anything
important across a physical hinge, and everything still works without it.

---

## 5. The breakpoints this site actually uses

Named for what they are, not for t-shirt sizes, and chosen from the table above
rather than from a framework default.

| Name | Range | What lives here |
| --- | --- | --- |
| `narrow` | to 359px | Galaxy Fold cover. Survival: one column, nothing clipped |
| `phone` | 360 to 429px | The bulk of real phones |
| `phone-wide` | 430 to 519px | Pro Max, and the Duo folded |
| `tweener` | 520 to 767px | **The dead zone.** Duo unfolded at 626 lives here |
| `tablet` | 768 to 1023px | iPads portrait, Fold 7 unfolded |
| `desktop` | 1024px and up | |

The `tweener` band is the one most sites do not have, and it is the one a
foldable spends its unfolded life in. In it the site moves to two columns and
opens up its spacing, because the screen is physically large even though the
number is small.

**Shape matters as well as width.** A viewport shorter than about 1:1.6 gets
reduced vertical rhythm and a shorter hero, so the Duo folded does not waste
its limited height. That is an `aspect-ratio` media query, not a width one,
which also catches any phone in landscape.

---

## 6. How to test

`npm run test:viewports` sweeps every width in the table and fails on
horizontal overflow, on a tap target under 44px, and on text under 16px in a
form field.

Widths swept: 320, 344, 360, 375, 384, 390, 402, 412, 430, 452, 466, 520, 626,
744, 768, 800, 820, 834, 883, 1024, 1180, 1280, 1440, 1920.

Two of those are there for one device each: **466 and 626 are the iPhone Duo**,
folded and unfolded. 344 is the old Fold cover screen.

Real hardware before launch, per the brief: an older small Android, a current
iPhone, an iPhone with a notch in landscape, an iPad in both orientations, a
Mac in Safari, Windows in Chrome and Edge.

---

## Sources

- [Apple unveils iPhone Duo](https://www.apple.com/newsroom/2026/09/apple-unveils-iphone-duo/)
- [iPhone Duo display resolutions explained, MacObserver](https://www.macobserver.com/tips/round-ups/iphone-duo-display-resolutions-explained-1878-x-2670-inside-1398-x-2034-outside-aspect-rat/)
- [Apple shipped a foldable iPhone. Safari still cannot tell you it folded.](https://dev.to/keishin_nishiura/apple-shipped-a-foldable-iphone-safari-still-cant-tell-you-it-folded-565a)
- [Android viewport sizes 2026](https://screensizechecker.com/devices/android-viewport-sizes)
- [Samsung Galaxy Z Fold 7 viewport, YesViz](https://yesviz.com/devices/samsung-z-fold7/)
- [Pixel 10 Pro Fold viewport, WebMobileFirst](https://www.webmobilefirst.com/en/devices/google-pixel-10-pro-fold-2026/)
