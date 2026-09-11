/*
  npm run status

  Prints what is filled in, what is missing, and what each missing value
  unlocks. Written for two readers:

    1. Hakop, or whoever is holding this next, who wants to know how far from
       taking a real order the site is without reading any code.
    2. A fresh Claude Code session opening this repository cold, which needs
       to know the state of the world before it changes anything.

  It reads the environment and the catalog. It changes nothing.

  The design rule here: never say "missing" without saying where the value
  comes from and what happens when it arrives. A checklist that only lists
  gaps makes people feel behind. A checklist that says what each gap unlocks
  makes them feel oriented.
*/

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const RED = "\x1b[31m";
const CYN = "\x1b[36m";

/* Load .env if there is one, without adding a dependency for it. */
try {
  const raw = await readFile(join(ROOT, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
} catch {
  /* No .env. Perfectly normal. Everything falls back to a safe default. */
}

const env = process.env;
const has = (k) => String(env[k] ?? "").trim().length > 0;
const truthy = (k) => ["true", "1", "yes"].includes(String(env[k] ?? "").trim().toLowerCase());

/* ------------------------------------------------------------------ */
/* What the site needs, and what each thing unlocks                    */
/* ------------------------------------------------------------------ */

const GROUPS = [
  {
    title: "To put the storefront online in its current closed state",
    note: "This is everything. Nothing below is required to deploy today.",
    items: [
      {
        key: null,
        label: "A Netlify site connected to this repository",
        ok: true,
        detail: "No account details live in the repo. Connect and deploy.",
      },
    ],
  },
  {
    title: "To let the store take an order",
    note: "The build refuses to open the store until the first three are set.",
    items: [
      {
        key: "PUBLIC_CFO_REGISTRATION_NUMBER",
        label: "Cottage food registration number",
        from: "Orange County Environmental Health, 714-433-6000",
        unlocks:
          "The legally required footer line on every page, and the launch gate.",
      },
      {
        key: "PUBLIC_CFO_COUNTY",
        label: "County of approval",
        from: "The same registration. It is Orange County unless you move.",
        unlocks: "The county name in the disclosure.",
      },
      {
        key: "PUBLIC_BUSINESS_NAME",
        label: "Registered business name",
        from: "Must match the county registration and the printed label exactly.",
        unlocks: "The name in the footer, the emails and the label.",
      },
      {
        key: "STRIPE_SECRET_KEY",
        label: "Stripe secret key",
        from: "dashboard.stripe.com, in Hakop's own Stripe account.",
        unlocks: "Creating a checkout session. Nothing can be charged without it.",
      },
      {
        key: "STRIPE_WEBHOOK_SECRET",
        label: "Stripe webhook signing secret",
        from: "Stripe dashboard, when you add the webhook endpoint.",
        unlocks:
          "The after payment California re-validation. Without it that check never runs.",
      },
      {
        key: "PUBLIC_STRIPE_PUBLISHABLE_KEY",
        label: "Stripe publishable key",
        from: "The same Stripe account. Safe to be public.",
        unlocks: "The browser side of checkout.",
      },
    ],
  },
  {
    title: "Needed before a real order is fulfilled, not before launch",
    items: [
      {
        key: "RESEND_API_KEY",
        label: "Transactional email",
        from: "resend.com, free tier is enough to start.",
        unlocks: "Order confirmation and ready for pickup emails.",
      },
      {
        key: "SUPABASE_URL",
        label: "Database",
        from: "supabase.com, free tier.",
        unlocks: "Order records, capacity holds and the annual cap meter.",
      },
      {
        key: "ADMIN_ALLOWED_EMAILS",
        label: "Admin allowlist",
        from: "Whichever addresses should reach the back office.",
        unlocks: "The admin. Phase 2, not built yet.",
      },
    ],
  },
  {
    title: "Genuinely optional. The site is correct without any of these",
    note: "No DBA, LLC, work phone, PO Box or mailbox number is needed to run, develop, deploy or hand over this site.",
    items: [
      {
        key: "PUBLIC_BUSINESS_ADDRESS",
        label: "Public business address",
        from: "An open decision, D-003. The footer shows the city until it is set.",
        unlocks: "A street address in the footer. The label needs one eventually.",
        optional: true,
      },
      {
        key: "PUBLIC_CONTACT_PHONE",
        label: "Contact phone",
        from: "Deliberately not a personal mobile. D-010.",
        unlocks: "A phone link in the footer. It is simply absent otherwise.",
        optional: true,
      },
      {
        key: "PUBLIC_SELLERS_PERMIT",
        label: "CDTFA seller's permit",
        from: "Only if CDTFA says this product mix needs one.",
        unlocks: "The permit number in the footer.",
        optional: true,
      },
      {
        key: "PUBLIC_INSTAGRAM_HANDLE",
        label: "Instagram handle",
        from: "Whenever there is one.",
        unlocks: "An Instagram link in the footer.",
        optional: true,
      },
      {
        key: "PUBLIC_CF_ANALYTICS_TOKEN",
        label: "Cloudflare Web Analytics",
        from: "Cloudflare dashboard, the domain is already there.",
        unlocks: "Visitor counts. No cookies, so no consent banner.",
        optional: true,
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Things that are not environment variables                           */
/* ------------------------------------------------------------------ */

async function catalogFacts() {
  const out = [];
  try {
    const raw = await readFile(join(ROOT, "src", "content", "products", "gata.json"), "utf8");
    const p = JSON.parse(raw);

    const priced = p.pricingStatus === "confirmed";
    out.push({
      label: "Tray prices",
      ok: priced,
      detail: priced
        ? "Confirmed."
        : "Marked placeholder, so nothing can be sold. Hakop sets the real prices.",
    });

    const pieces = p.piecesPerUnit != null;
    out.push({
      label: "Pieces per tray",
      ok: pieces,
      detail: pieces
        ? `${p.piecesPerUnit} per unit.`
        : "Not set. Somebody counts a real tray. It drives the batch and capacity maths.",
    });

    const weight = p.netWeightGrams != null;
    out.push({
      label: "Net weight",
      ok: weight,
      detail: weight ? "Set." : "Not set. It is legally required on the printed label.",
    });

    const priceIds = (p.variants ?? []).every((v) => v.stripePriceId);
    out.push({
      label: "Stripe price IDs",
      ok: priceIds,
      detail: priceIds ? "All variants linked." : "Created in Stripe once prices are final.",
    });
  } catch {
    out.push({ label: "Product catalog", ok: false, detail: "Could not read the gata record." });
  }
  return out;
}

/* ------------------------------------------------------------------ */

console.log(`\n${BOLD}Hakop's Bakery, readiness${RESET}`);
console.log(`${DIM}Run npm run status any time. It reads only, it changes nothing.${RESET}\n`);

let blocking = 0;

for (const group of GROUPS) {
  console.log(`${BOLD}${group.title}${RESET}`);
  if (group.note) console.log(`${DIM}  ${group.note}${RESET}`);

  for (const item of group.items) {
    const set = item.key === null ? item.ok : has(item.key);
    if (!set && !item.optional && item.key !== null) blocking += 1;

    const mark = set ? `${GRN}set  ${RESET}` : item.optional ? `${DIM}unset${RESET}` : `${YEL}unset${RESET}`;
    console.log(`  ${mark} ${item.label}`);
    if (item.key) console.log(`        ${DIM}${item.key}${RESET}`);
    if (!set && item.from) console.log(`        ${DIM}from: ${item.from}${RESET}`);
    if (!set && item.unlocks) console.log(`        ${DIM}unlocks: ${item.unlocks}${RESET}`);
    if (item.detail) console.log(`        ${DIM}${item.detail}${RESET}`);
  }
  console.log();
}

console.log(`${BOLD}Things a person has to decide, not a variable${RESET}`);
for (const f of await catalogFacts()) {
  console.log(`  ${f.ok ? `${GRN}done ${RESET}` : `${YEL}open ${RESET}`} ${f.label}`);
  console.log(`        ${DIM}${f.detail}${RESET}`);
}
console.log();

/* ------------------------------------------------------------------ */

const storeOpenRequested = truthy("PUBLIC_STORE_OPEN");
const canOpen =
  has("PUBLIC_CFO_REGISTRATION_NUMBER") &&
  has("PUBLIC_CFO_COUNTY") &&
  has("PUBLIC_BUSINESS_NAME");

console.log(`${BOLD}Where this stands${RESET}`);

if (!canOpen) {
  console.log(
    `  ${CYN}The site is ready to deploy in its closed state.${RESET} It shows the story,\n` +
      "  the product, the photography and a waiting list, with no cart and no price\n" +
      "  presented as purchasable. That is the correct and legal thing to publish\n" +
      "  before the registration exists, and it is worth publishing now: it gives\n" +
      "  Hakop something real to share while the paperwork moves.",
  );
  console.log(
    `\n  ${YEL}The store cannot take an order yet${RESET}, and the build enforces that\n` +
      `  rather than trusting anyone to remember. ${blocking} required value(s) are unset.`,
  );
  if (storeOpenRequested) {
    console.log(
      `\n  ${RED}PUBLIC_STORE_OPEN is true but the compliance values are missing.${RESET}\n` +
        "  npm run build will refuse. That is deliberate.",
    );
  }
} else if (storeOpenRequested) {
  console.log(`  ${GRN}The store is open.${RESET} Work through docs/QA-CHECKLIST.md before trusting it.`);
} else {
  console.log(
    `  ${GRN}Everything the store needs is set${RESET}, but PUBLIC_STORE_OPEN is false,\n` +
      "  so the site is still showing the closed page. Flip it when you are ready.",
  );
}

console.log(`\n${DIM}  Paperwork, in order, with lead times:  docs/LAUNCH.md`);
console.log(`  Picking this up cold:                  docs/HANDOVER.md`);
console.log(`  What every value means:                .env.example${RESET}\n`);
