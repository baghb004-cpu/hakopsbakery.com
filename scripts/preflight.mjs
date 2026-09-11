/*
  Build gate. Runs before every `astro build`.

  Section 4 of the brief: "The build refuses to deploy in open mode if the
  registration number is empty. Make it a hard check in the build script, not
  a reminder in a doc." This is that check.

  A site that is taking money while advertising a registration number it does
  not have is a compliance problem, not a typo. So this exits non zero and
  Netlify fails the deploy rather than publishing it.
*/

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
