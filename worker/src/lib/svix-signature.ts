// Svix webhook signature verification (used by Resend, and many others).
//
// Signed string: `${svix-id}.${svix-timestamp}.${rawBody}`
// Signature header: space-separated list of `v1,<base64sig>` entries —
// we accept the request if any one matches.
// Secret format: `whsec_<base64>` — the prefix is stripped before use.
//
// We also enforce a freshness window so an attacker can't replay an
// old captured signed body indefinitely.

const FIVE_MINUTES_SECONDS = 5 * 60;

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function base64ToBytes(input: string): Uint8Array | null {
  try {
    const binary = atob(input);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeSecret(secret: string): Uint8Array | null {
  const stripped = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return base64ToBytes(stripped);
}

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function readSvixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get("svix-id") ?? headers.get("webhook-id"),
    timestamp:
      headers.get("svix-timestamp") ?? headers.get("webhook-timestamp"),
    signature:
      headers.get("svix-signature") ?? headers.get("webhook-signature"),
  };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: SvixHeaders,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing_signature_headers" };
  }
  const tsNumber = Number(headers.timestamp);
  if (!Number.isFinite(tsNumber)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  if (Math.abs(nowSeconds - tsNumber) > FIVE_MINUTES_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const secretBytes = decodeSecret(secret);
  if (!secretBytes) return { ok: false, reason: "bad_secret" };

  const signedString = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedString),
    ),
  );

  // Header is space-separated list of `v1,<base64>` (and may carry future
  // versions like `v2,...` we don't recognize).
  for (const entry of headers.signature.split(" ")) {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) continue;
    const provided = base64ToBytes(value);
    if (provided && constantTimeEqual(provided, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "no_match" };
}
