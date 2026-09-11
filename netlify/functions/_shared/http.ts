/**
 * Request and response plumbing shared by every function.
 *
 * Two rules run through this file.
 *
 * 1. A refusal is not a crash. A ZIP outside California, a sold out bake
 *    date, a stale consent version: these are ordinary answers and they come
 *    back as a structured body the browser can act on, not as an exception.
 *
 * 2. Nothing leaks. A customer sees a stable error code, one plain sentence,
 *    and a reference string. The real cause, including anything Stripe said,
 *    goes to the function log against that same reference. A raw provider
 *    error can carry an account id, a key prefix, or the shape of an internal
 *    object, and none of that belongs in a browser.
 */

/** The body every refusal and every failure uses. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** Present only on 5xx, so a customer can quote it in an email. */
    readonly reference?: string;
    readonly [extra: string]: unknown;
  };
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  /*
    Tier 2 data (availability, capacity) and anything about one customer must
    never sit in a CDN or a browser cache. Section 1 of docs/ARCHITECTURE.md:
    a stale sold out answer is the specific failure the brief warns about.
  */
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}

/** A 200 carrying a successful answer. */
export function ok(body: Record<string, unknown>): Response {
  return jsonResponse(200, { ok: true, ...body });
}

/**
 * A refusal the customer can act on. Still a real HTTP status, because a
 * fetch wrapper that only checks response.ok should not treat "sold out" as
 * a success, but the body is the useful part.
 */
export function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, { ok: false, error: { code, message, ...extra } });
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return jsonResponse(
    405,
    {
      ok: false,
      error: { code: "method-not-allowed", message: "That method is not allowed here." },
    },
    { allow: allowed.join(", ") },
  );
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return jsonResponse(
    429,
    {
      ok: false,
      error: {
        code: "rate-limited",
        message: "Too many requests. Wait a moment and try again.",
      },
    },
    { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );
}

/**
 * A reference that appears in exactly two places: the response a customer
 * holds, and the log line that says what really happened.
 */
export function newReference(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return `ref_${out}`;
}

export function internalError(reference: string, message?: string): Response {
  return jsonResponse(500, {
    ok: false,
    error: {
      code: "internal-error",
      message:
        message ??
        "Something went wrong on our side. Nothing was charged. Try again, " +
          "and quote the reference below if it keeps happening.",
      reference,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Body reading                                                        */
/* ------------------------------------------------------------------ */

export type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response };

/**
 * Read a JSON body, with a hard ceiling on size.
 *
 * The ceiling is the point. A function that awaits req.json() on an unbounded
 * body will happily buffer whatever it is given. Sixteen kilobytes is far
 * more than a cart of a few lines ever needs.
 */
export async function readJsonBody(req: Request, maxBytes = 16 * 1024): Promise<BodyResult> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return { ok: false, response: refuse(413, "body-too-large", "That request is too large.") };
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: refuse(400, "unreadable-body", "The request body could not be read.") };
  }

  if (text.length > maxBytes) {
    return { ok: false, response: refuse(413, "body-too-large", "That request is too large.") };
  }
  if (text.trim() === "") {
    return { ok: false, response: refuse(400, "empty-body", "The request body was empty.") };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: refuse(400, "malformed-json", "The request body is not valid JSON.") };
  }
}

/* ------------------------------------------------------------------ */
/* Who is asking                                                       */
/* ------------------------------------------------------------------ */

/**
 * Best available client address, for rate limiting only.
 *
 * Netlify sets x-nf-client-connection-ip and it is the one header here a
 * client cannot forge. x-forwarded-for is a fallback for local development,
 * where it is set by the dev proxy. Never treat either as an identity.
 */
export function clientIp(req: Request, context?: { ip?: string }): string {
  const fromContext = typeof context?.ip === "string" ? context.ip.trim() : "";
  if (fromContext !== "") return fromContext;

  const direct = req.headers.get("x-nf-client-connection-ip");
  if (direct !== null && direct.trim() !== "") return direct.trim();

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.trim() !== "") {
    const first = forwarded.split(",")[0];
    if (first !== undefined && first.trim() !== "") return first.trim();
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * One JSON object per line, which is what Netlify's log viewer and any log
 * drain downstream can actually filter on.
 */
function emit(level: string, event: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const consoleLogger: Logger = {
  info: (event, fields = {}) => emit("info", event, fields),
  warn: (event, fields = {}) => emit("warn", event, fields),
  error: (event, fields = {}) => emit("error", event, fields),
};

/** A logger that keeps its lines in memory. Tests assert on these. */
export function memoryLogger(): Logger & { readonly lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const push = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    lines.push({ level, event, ...fields });
  };
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

/**
 * Turn anything thrown into something safe to log.
 *
 * Stripe errors carry a type and a code that are genuinely useful in a log
 * and harmless there. The message can quote request content, so it is kept
 * but never returned to a browser: everything this produces is log only.
 */
export function describeError(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    const extra = cause as Error & { type?: unknown; code?: unknown; statusCode?: unknown };
    return {
      name: cause.name,
      message: cause.message,
      ...(typeof extra.type === "string" ? { stripeType: extra.type } : {}),
      ...(typeof extra.code === "string" ? { stripeCode: extra.code } : {}),
      ...(typeof extra.statusCode === "number" ? { stripeStatus: extra.statusCode } : {}),
    };
  }
  return { name: "NonError", message: String(cause) };
}
