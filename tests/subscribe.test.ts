/**
 * subscribe. The coming soon capture, which is the only thing a visitor can
 * do while the registration is pending.
 */

import { describe, expect, it } from "vitest";
import {
  SUBSCRIBE_CONSENT_TEXT,
  SUBSCRIBE_CONSENT_VERSION,
  handleSubscribe,
} from "../netlify/functions/subscribe";
import type { SubscribeDeps } from "../netlify/functions/subscribe";
import { createMemoryOrderStore } from "../netlify/functions/_shared/store";
import { createRateLimiter } from "../netlify/functions/_shared/rate-limit";
import { memoryLogger } from "../netlify/functions/_shared/http";
import { postJson, readBody, testSettings } from "./function-harness";

function deps(overrides: Partial<SubscribeDeps> = {}): SubscribeDeps {
  return {
    now: () => new Date("2026-09-11T17:00:00.000Z"),
    store: createMemoryOrderStore(),
    settings: testSettings(),
    rateLimiter: createRateLimiter(),
    logger: memoryLogger(),
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return postJson("/api/subscribe", body, headers);
}

describe("taking an address", () => {
  it("stores it with the exact wording that was agreed to", async () => {
    const bench = deps();
    const store = bench.store as ReturnType<typeof createMemoryOrderStore>;

    const response = await handleSubscribe(
      post({ email: "  Someone@Example.COM ", consent: true, source: "home" }),
      bench,
    );

    expect(response.status).toBe(200);
    const saved = store.state.subscribers.get("someone@example.com");
    expect(saved).toBeDefined();
    expect(saved?.email).toBe("someone@example.com");
    expect(saved?.consentText).toBe(SUBSCRIBE_CONSENT_TEXT);
    expect(saved?.consentVersion).toBe(SUBSCRIBE_CONSENT_VERSION);
    expect(saved?.subscribedAt).toBe("2026-09-11T17:00:00.000Z");
    expect(saved?.source).toBe("home");
  });

  it("says in the response what was agreed to and how to undo it", async () => {
    const response = await handleSubscribe(
      post({ email: "someone@example.com", consent: true }),
      deps(),
    );
    const body = await readBody(response);
    const consent = body["consent"] as Record<string, unknown>;

    expect(consent["recorded"]).toBe(true);
    expect(consent["text"]).toBe(SUBSCRIBE_CONSENT_TEXT);
    expect(consent["version"]).toBe(SUBSCRIBE_CONSENT_VERSION);
    expect(consent["at"]).toBe("2026-09-11T17:00:00.000Z");
    expect(String(consent["usedFor"])).toContain("opens");
    expect(String(consent["notUsedFor"])).toContain("not sold");
    expect(String(consent["unsubscribe"])).toContain("hello@hakopsbakery.com");
  });

  it("does not say whether an address was already on the list", async () => {
    const bench = deps();
    const first = await readBody(
      await handleSubscribe(post({ email: "twice@example.com", consent: true }), bench),
    );
    const second = await readBody(
      await handleSubscribe(post({ email: "twice@example.com", consent: true }), bench),
    );

    expect(second).toEqual({ ...first, consent: second["consent"] });
    expect(second["status"]).toBe(first["status"]);
    expect(second["message"]).toBe(first["message"]);

    const store = bench.store as ReturnType<typeof createMemoryOrderStore>;
    expect(store.state.subscribers.size).toBe(1);
  });
});

describe("refusing an address", () => {
  it("will not take one without consent", async () => {
    const bench = deps();
    const response = await handleSubscribe(
      post({ email: "someone@example.com", consent: false }),
      bench,
    );
    expect(response.status).toBe(400);
    expect((await readBody(response))["error"]).toMatchObject({ code: "consent-required" });
    expect((bench.store as ReturnType<typeof createMemoryOrderStore>).state.subscribers.size).toBe(0);
  });

  it("refuses something that is not an address", async () => {
    for (const email of ["", "someone", "someone@", "@example.com", "a b@example.com", "someone@example"]) {
      const response = await handleSubscribe(post({ email, consent: true }), deps());
      expect(response.status).toBe(400);
    }
  });

  it("refuses an address longer than an address can be", async () => {
    const response = await handleSubscribe(
      post({ email: `${"a".repeat(250)}@example.com`, consent: true }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it("refuses anything but POST", async () => {
    const response = await handleSubscribe(
      new Request("https://hakopsbakery.com/api/subscribe"),
      deps(),
    );
    expect(response.status).toBe(405);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await handleSubscribe(
      new Request("https://hakopsbakery.com/api/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      deps(),
    );
    expect(response.status).toBe(400);
  });
});

describe("keeping the list clean", () => {
  it("swallows a bot that filled in the hidden field", async () => {
    const bench = deps();
    const response = await handleSubscribe(
      post({ email: "bot@example.com", consent: true, website: "https://spam.example" }),
      bench,
    );

    /* It looks like a success, and nothing was stored. */
    expect(response.status).toBe(200);
    expect((bench.store as ReturnType<typeof createMemoryOrderStore>).state.subscribers.size).toBe(0);
  });

  it("rate limits one address from hammering the form", async () => {
    const bench = deps();
    let last = new Response();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await handleSubscribe(
        post(
          { email: "someone@example.com", consent: true },
          { "x-nf-client-connection-ip": "203.0.113.11" },
        ),
        bench,
      );
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).not.toBeNull();
  });

  it("keeps a durable copy in the log while there is no database", async () => {
    const logger = memoryLogger();
    const bench = deps({ logger });
    await handleSubscribe(post({ email: "someone@example.com", consent: true }), bench);

    const captured = logger.lines.find((line) => line["event"] === "subscribe.captured-to-log-only");
    expect(captured).toBeDefined();
    expect(captured?.["email"]).toBe("someone@example.com");
  });
});
