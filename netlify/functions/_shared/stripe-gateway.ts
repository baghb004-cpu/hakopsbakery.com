/**
 * Everything this codebase asks Stripe to do, behind four methods.
 *
 * The interface exists so that a test can watch exactly what is sent without
 * a network, which matters because the interesting assertions here are about
 * the parameters: that no price came from the browser, that the country list
 * is locked to the United States, that an idempotency key was set. None of
 * that needs a real API call to check, and all of it needs checking.
 *
 * What is NOT faked anywhere is signature verification. That is real Stripe
 * SDK code in the tests as well as in production, because a webhook that
 * verifies signatures incorrectly is the specific bug this whole file exists
 * to avoid, and a fake that always says yes would test nothing.
 */

import Stripe from "stripe";

export interface CreatedSession {
  readonly id: string;
  readonly url: string | null;
  readonly expiresAt: number | null;
}

export interface CreatedRefund {
  readonly id: string;
  readonly status: string | null;
}

export interface StripeGateway {
  readonly name: string;
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    options: { readonly idempotencyKey: string },
  ): Promise<CreatedSession>;

  /**
   * Verify and parse. Takes the RAW body as a string, never a parsed object,
   * because the signature is over the exact bytes Stripe sent.
   */
  constructEvent(rawBody: string, signatureHeader: string, secret: string): Promise<Stripe.Event>;

  createRefund(
    params: Stripe.RefundCreateParams,
    options: { readonly idempotencyKey: string },
  ): Promise<CreatedRefund>;
}

/*
  The API version is deliberately not pinned here. The SDK pins one, and the
  TypeScript types in the package describe that same version, so overriding
  it by hand is how the two drift apart.

  The version of a WEBHOOK payload is a separate thing entirely: it is set on
  the endpoint in the Stripe dashboard and the SDK has no say in it. That is
  why stripe-webhook.ts reads the final address from both the current
  location and the older one.
*/
function client(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    /*
      Two retries, which are safe because every write below carries an
      idempotency key. Without the key a retry can charge twice.
    */
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "hakopsbakery.com", url: "https://hakopsbakery.com" },
  });
}

export function createStripeGateway(secretKey: string): StripeGateway {
  const stripe = client(secretKey);

  return {
    name: "stripe",

    async createCheckoutSession(params, options) {
      const session = await stripe.checkout.sessions.create(params, {
        idempotencyKey: options.idempotencyKey,
      });
      return {
        id: session.id,
        url: session.url ?? null,
        expiresAt: typeof session.expires_at === "number" ? session.expires_at : null,
      };
    },

    async constructEvent(rawBody, signatureHeader, secret) {
      /*
        constructEventAsync rather than constructEvent: the async form uses
        the platform crypto provider, which is the one that works in every
        runtime Netlify might put this function in. The synchronous form
        reaches for node:crypto directly.
      */
      return await stripe.webhooks.constructEventAsync(rawBody, signatureHeader, secret);
    },

    async createRefund(params, options) {
      const refund = await stripe.refunds.create(params, {
        idempotencyKey: options.idempotencyKey,
      });
      return { id: refund.id, status: refund.status ?? null };
    },
  };
}

/**
 * Signature verification with no API key.
 *
 * Verification is a keyed hash over the request body and the webhook signing
 * secret. It needs no account credentials at all, so a deployment that has
 * the signing secret but not the API key can still tell a real delivery from
 * a forged one, and can still refuse the forged one, which is the part that
 * must never depend on configuration being complete.
 */
export function createVerifyOnlyGateway(): Pick<StripeGateway, "constructEvent"> {
  const stripe = new Stripe("sk_verification_only", { maxNetworkRetries: 0 });
  return {
    async constructEvent(rawBody, signatureHeader, secret) {
      return await stripe.webhooks.constructEventAsync(rawBody, signatureHeader, secret);
    },
  };
}

/**
 * The signature Stripe would send for a given body. Tests use it to produce
 * genuinely valid headers, and genuinely invalid ones, against the real
 * verification code.
 */
export function signWebhookPayload(payload: string, secret: string, timestampSeconds?: number): string {
  const stripe = new Stripe("sk_signing_only", { maxNetworkRetries: 0 });
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(timestampSeconds === undefined ? {} : { timestamp: timestampSeconds }),
  });
}

export type { Stripe };
