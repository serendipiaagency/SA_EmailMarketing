// HMAC-signed unsubscribe tokens. Stateless: no DB row per token.
//
// Wire format: <payload>.<signature>
//   payload   = base64url(JSON({ e: email, s?: sentEmailId, t: issuedAt }))
//   signature = base64url(HMAC-SHA256(payload, secret))
//
// Tokens do NOT expire. An unsubscribe link must keep working forever so
// recipients can opt out of mail they received years ago. `t` is kept only
// for observability / future revocation, never enforced.

const encoder = new TextEncoder();

function getSecret(env: CloudflareBindings): string {
  const raw = (env as unknown as { UNSUBSCRIBE_TOKEN_SECRET?: string })
    .UNSUBSCRIBE_TOKEN_SECRET;
  if (!raw) {
    throw new Error(
      "UNSUBSCRIBE_TOKEN_SECRET is not configured. Set it with `wrangler secret put UNSUBSCRIBE_TOKEN_SECRET`.",
    );
  }
  return raw;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function verifySig(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await importKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBytes(signature),
    encoder.encode(payload),
  );
}

export interface UnsubscribePayload {
  email: string;
  sentEmailId?: string;
}

export async function signUnsubscribeToken(
  env: CloudflareBindings,
  payload: UnsubscribePayload,
): Promise<string> {
  const secret = getSecret(env);
  const body = {
    e: payload.email.trim().toLowerCase(),
    s: payload.sentEmailId ?? undefined,
    t: Math.floor(Date.now() / 1000),
  };
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(body)));
  const signature = await sign(encoded, secret);
  return `${encoded}.${signature}`;
}

export async function verifyUnsubscribeToken(
  env: CloudflareBindings,
  token: string,
): Promise<UnsubscribePayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let secret: string;
  try {
    secret = getSecret(env);
  } catch {
    return null;
  }

  // Any failure in atob / WebCrypto verify on a malformed token must
  // surface as a clean `null`, not a 500. We catch broadly because the
  // caller's contract is "valid payload or nothing".
  try {
    const ok = await verifySig(encoded, signature, secret);
    if (!ok) return null;
    const json = new TextDecoder().decode(base64UrlToBytes(encoded));
    const parsed = JSON.parse(json) as { e?: unknown; s?: unknown };
    if (typeof parsed.e !== "string" || parsed.e.length === 0) return null;
    return {
      email: parsed.e,
      sentEmailId: typeof parsed.s === "string" ? parsed.s : undefined,
    };
  } catch {
    return null;
  }
}
