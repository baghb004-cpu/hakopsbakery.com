/*
  Build gate. Runs before every `astro build`.

  Section 4 of the brief: "The build refuses to deploy in open mode if the
  registration number is empty. Make it a hard check in the build script, not
  a reminder in a doc." This is that check.

  A site that is taking money while advertising a registration number it does
  not have is a compliance problem, not a typo. So this exits non zero and
  Netlify fails the deploy rather than publishing it.
*/

import { readFileSync } from "node:fs";

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

const env = process.env;
const problems = [];
const warnings = [];

const truthy = (v) => ["true", "1", "yes"].includes(String(v ?? "").trim().toLowerCase());
const present = (v) => String(v ?? "").trim().length > 0;

/*
  Words nobody's county puts on a registration. Matched as whole words so a
  real number is never refused for containing one of them inside a longer
  token, and deliberately all alphabetic: a run of digits like 1234 reads as a
  stand in to a human but is perfectly possible in an issued number, and a
  gate that refuses a real launch is worse than the gap it closes.

  If a genuine number ever trips this, narrow the list rather than delete the
  check.
*/
const PLACEHOLDER_WORDS =
  /(^|[^a-z0-9])(test|testing|todo|tbd|tba|pending|placeholder|example|sample|dummy|fake|changeme|change_me|fixme|xxx+|n\/?a|none|null|undefined|your[-_ ]?number|reg[-_ ]?number)([^a-z0-9]|$)/i;

const looksLikePlaceholder = (v) => PLACEHOLDER_WORDS.test(String(v ?? "").trim());

const storeOpen = truthy(env.PUBLIC_STORE_OPEN);

if (storeOpen) {
  if (!present(env.PUBLIC_CFO_REGISTRATION_NUMBER)) {
    problems.push(
      "PUBLIC_STORE_OPEN is true but PUBLIC_CFO_REGISTRATION_NUMBER is empty.\n" +
        "    A cottage food operation advertising to the public must display its\n" +
        "    registration number. Get the number from Orange County Environmental\n" +
        "    Health (714-433-6000) and set it in the Netlify environment, or set\n" +
        "    PUBLIC_STORE_OPEN to false and ship the coming soon page.",
    );
  } else if (looksLikePlaceholder(env.PUBLIC_CFO_REGISTRATION_NUMBER)) {
    /*
      docs/COMPLIANCE.md section 1: "A PENDING value is stored as an empty
      environment variable, never as a placeholder string. An empty value is
      visibly missing. A placeholder looks real and gets printed." Empty was
      already refused. This is the other half, because a stand in number is
      printed on all seventeen pages exactly like a real one and nothing
      downstream can tell the difference.

      Blocking only on a live key. Building the open storefront locally with a
      stand in number is how the store open path is reviewed at all, and the
      QA checklist asks for it, so that stays possible and merely noisy. A
      build holding a live Stripe key is a build that can take somebody's
      money, and that one is refused.
    */
    const message =
      `PUBLIC_CFO_REGISTRATION_NUMBER is ${JSON.stringify(env.PUBLIC_CFO_REGISTRATION_NUMBER.trim())},\n` +
      "    which reads as a stand in rather than a number the county issued, and it\n" +
      "    is printed on every page exactly as though it were real.";
    if (String(env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_")) {
      problems.push(
        `${message}\n` +
          "    Stripe is in live mode, so this would be a real storefront advertising\n" +
          "    a registration that does not exist. Set the issued number, or leave the\n" +
          "    variable empty and set PUBLIC_STORE_OPEN to false.",
      );
    } else {
      warnings.push(
        `${message}\n` +
          "    Fine for a local review of the open storefront. Never deploy it, and\n" +
          "    never commit the build output it produces.",
      );
    }
  }
  if (!present(env.PUBLIC_CFO_COUNTY)) {
    problems.push("PUBLIC_STORE_OPEN is true but PUBLIC_CFO_COUNTY is empty.");
  }
  if (!present(env.PUBLIC_BUSINESS_NAME)) {
    problems.push(
      "PUBLIC_STORE_OPEN is true but PUBLIC_BUSINESS_NAME is empty. The name in\n" +
        "    the footer must match the name registered with the county.",
    );
  }
  if (!present(env.STRIPE_SECRET_KEY)) {
    problems.push(
      "PUBLIC_STORE_OPEN is true but STRIPE_SECRET_KEY is empty. Checkout would\n" +
        "    fail on the first order.",
    );
  }
  if (!present(env.STRIPE_WEBHOOK_SECRET)) {
    problems.push(
      "PUBLIC_STORE_OPEN is true but STRIPE_WEBHOOK_SECRET is empty. Without it\n" +
        "    the webhook cannot verify Stripe signatures, which means the\n" +
        "    California re-validation in Section 8 step 5 never runs.",
    );
  }
  if (present(env.STRIPE_SECRET_KEY) && env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
    warnings.push(
      "The store is open but Stripe is in test mode. Real customers will not\n" +
        "    be charged. Switch to the live key when you are ready to sell.",
    );
  }
} else {
  warnings.push(
    "Building in coming soon mode. The storefront, cart and checkout are off.\n" +
      "    Set PUBLIC_STORE_OPEN=true once the registration number is in hand.",
  );
}

/*
  The federal holiday table in src/lib/carriers.ts is written out by hand,
  because the observed date of a holiday landing on a weekend is a rule about
  rules. A hand written table runs out. When it does, isHoliday() answers
  false for every date past the end of it and the shipping calculator quietly
  promises a delivery on Christmas Day.

  The comment at the top of that table has always said this check exists. It
  did not. Non blocking on purpose: a short table is a thing to fix this week,
  not a reason to refuse a deploy that is otherwise correct.
*/
const HOLIDAY_RUNWAY_DAYS = 365;
try {
  const source = readFileSync(new URL("../src/lib/carriers.ts", import.meta.url), "utf8");
  const block = /FEDERAL_HOLIDAYS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
  const dates = block === null ? [] : [...block[1].matchAll(/"(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
  if (dates.length === 0) {
    warnings.push(
      "Could not read FEDERAL_HOLIDAYS out of src/lib/carriers.ts. Shipping\n" +
        "    dates are worked out from that table and nothing is checking it.",
    );
  } else {
    const last = dates.reduce((latest, date) => (date > latest ? date : latest), dates[0]);
    const daysLeft = Math.round(
      (Date.parse(`${last}T12:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`)) /
        86_400_000,
    );
    if (daysLeft < HOLIDAY_RUNWAY_DAYS) {
      warnings.push(
        `The federal holiday table in src/lib/carriers.ts ends on ${last}, which is\n` +
          `    ${daysLeft} day(s) away. Past that date every holiday reads as an ordinary\n` +
          "    working day and the shipping calculator will promise arrivals that\n" +
          "    cannot happen. Add the next year, observed dates and all.",
      );
    }
  }
} catch (cause) {
  warnings.push(`Could not check the federal holiday table: ${String(cause)}`);
}

// A secret with a PUBLIC_ prefix ends up in the browser bundle. Catch it here.
for (const key of Object.keys(env)) {
  if (!key.startsWith("PUBLIC_")) continue;
  const value = String(env[key] ?? "");
  if (/^(sk_live_|sk_test_|rk_live_|whsec_|eyJ[\w-]+\.[\w-]+\.)/.test(value)) {
    problems.push(
      `${key} looks like a secret key but carries the PUBLIC_ prefix, which\n` +
        "    means Astro will inline it into the JavaScript that every visitor\n" +
        "    downloads. Rename it without the prefix.",
    );
  }
}

console.log(`${DIM}preflight${RESET} ${storeOpen ? "store open" : "coming soon"} mode`);

for (const w of warnings) console.log(`${YELLOW}  warn${RESET}  ${w}`);

if (problems.length > 0) {
  console.error(`\n${RED}Build refused.${RESET} ${problems.length} blocking problem(s):\n`);
  for (const p of problems) console.error(`${RED}  ✗${RESET}  ${p}\n`);
  console.error(`${DIM}  See Section 4 of docs/BRIEF.md.${RESET}\n`);
  process.exit(1);
}

console.log(`${GREEN}  ok${RESET}    compliance configuration is consistent\n`);
