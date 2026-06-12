import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { exports as workerExports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { suppressions } from "../db/suppressions.schema";

// Test secret matches vitest.config.test.ts: whsec_<base64 of "test-resend-webhook-secret">
const TEST_SECRET_RAW = "test-resend-webhook-secret";

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function signSvix(
  rawBody: string,
  opts: { id?: string; timestampSeconds?: number } = {},
): Promise<{ id: string; timestamp: string; signature: string }> {
  const id = opts.id ?? "msg_test_1";
  const timestamp = String(
    opts.timestampSeconds ?? Math.floor(Date.now() / 1000),
  );
  const signed = `${id}.${timestamp}.${rawBody}`;
  const secretBytes = new TextEncoder().encode(TEST_SECRET_RAW);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
  );
  return { id, timestamp, signature: `v1,${bytesToBase64(sig)}` };
}

async function postWebhook(
  path: string,
  body: unknown,
  opts: { skipHeaders?: boolean; timestampSeconds?: number } = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!opts.skipHeaders) {
    const sig = await signSvix(raw, {
      timestampSeconds: opts.timestampSeconds,
    });
    headers["svix-id"] = sig.id;
    headers["svix-timestamp"] = sig.timestamp;
    headers["svix-signature"] = sig.signature;
  }
  return workerExports.default.fetch(`http://localhost${path}`, {
    method: "POST",
    body: raw,
    headers,
  });
}

describe("POST /webhooks/resend", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("suppresses recipients on email.bounced (hard_bounce)", async () => {
    const db = getDb();
    const res = await postWebhook("/webhooks/resend", {
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "re_abc123",
        to: ["bouncer@example.com"],
        from: "me@saasmail.test",
        subject: "Test",
        bounce: { type: "Permanent", subType: "General" },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      action: string;
      reason: string;
      recipients: number;
    };
    expect(body.action).toBe("suppressed");
    expect(body.reason).toBe("hard_bounce");
    expect(body.recipients).toBe(1);

    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, "bouncer@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("hard_bounce");
    expect(rows[0].source).toBe("webhook:resend");
    expect(rows[0].sentEmailId).toBe("re_abc123");
  });

  it("suppresses recipient on email.complained (complaint)", async () => {
    const db = getDb();
    await postWebhook("/webhooks/resend", {
      type: "email.complained",
      data: { email_id: "re_456", to: "spammed@example.com" },
    });
    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, "spammed@example.com"));
    expect(rows[0].reason).toBe("complaint");
  });

  it("ignores informational events (delivered/opened/sent)", async () => {
    const db = getDb();
    const res = await postWebhook("/webhooks/resend", {
      type: "email.delivered",
      data: { email_id: "re_x", to: ["fine@example.com"] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("ignored");
    const rows = await db.select().from(suppressions);
    expect(rows).toHaveLength(0);
  });

  it("rejects requests with missing signature headers (401)", async () => {
    const res = await postWebhook(
      "/webhooks/resend",
      { type: "email.bounced", data: { to: "x@example.com" } },
      { skipHeaders: true },
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests with stale timestamp (>5 min)", async () => {
    const res = await postWebhook(
      "/webhooks/resend",
      { type: "email.bounced", data: { to: "x@example.com" } },
      { timestampSeconds: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect(res.status).toBe(401);
  });

  it("rejects requests signed with the wrong secret (401)", async () => {
    const raw = JSON.stringify({
      type: "email.bounced",
      data: { to: "x@example.com" },
    });
    // Sign with a different secret
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const wrongSecret = new TextEncoder().encode("wrong-secret");
    const key = await crypto.subtle.importKey(
      "raw",
      wrongSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${id}.${ts}.${raw}`),
      ),
    );
    const res = await workerExports.default.fetch(
      "http://localhost/webhooks/resend",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": id,
          "svix-timestamp": ts,
          "svix-signature": `v1,${bytesToBase64(sig)}`,
        },
        body: raw,
      },
    );
    expect(res.status).toBe(401);
  });

  it("handles multi-recipient bounce arrays", async () => {
    const db = getDb();
    const res = await postWebhook("/webhooks/resend", {
      type: "email.bounced",
      data: {
        email_id: "re_multi",
        to: ["a@example.com", "b@example.com"],
      },
    });
    expect(res.status).toBe(200);
    const rows = await db.select().from(suppressions);
    expect(rows.map((r) => r.email).sort()).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("returns no_recipient when payload has no `to`", async () => {
    const res = await postWebhook("/webhooks/resend", {
      type: "email.bounced",
      data: { email_id: "re_x" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string };
    expect(body.action).toBe("no_recipient");
  });
});
