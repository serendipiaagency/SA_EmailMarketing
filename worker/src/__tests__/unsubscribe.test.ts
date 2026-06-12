import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../lib/unsubscribe-token";
import { buildListUnsubscribeHeaders } from "../lib/list-unsubscribe";
import { suppressions } from "../db/suppressions.schema";

describe("unsubscribe-token helper", () => {
  it("round-trips email through sign + verify", async () => {
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "Foo@Example.com" },
    );
    expect(token).toContain(".");
    const decoded = await verifyUnsubscribeToken(
      env as unknown as CloudflareBindings,
      token,
    );
    // email should come back canonicalized (lowercased)
    expect(decoded?.email).toBe("foo@example.com");
    expect(decoded?.sentEmailId).toBeUndefined();
  });

  it("preserves sentEmailId across round-trip", async () => {
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "x@example.com", sentEmailId: "sent-123" },
    );
    const decoded = await verifyUnsubscribeToken(
      env as unknown as CloudflareBindings,
      token,
    );
    expect(decoded?.sentEmailId).toBe("sent-123");
  });

  it("rejects tampered signature", async () => {
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "x@example.com" },
    );
    const [payload, sig] = token.split(".");
    // flip a character in the signature
    const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === "A" ? "B" : "A");
    const decoded = await verifyUnsubscribeToken(
      env as unknown as CloudflareBindings,
      `${payload}.${tamperedSig}`,
    );
    expect(decoded).toBeNull();
  });

  it("rejects tampered payload", async () => {
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "x@example.com" },
    );
    const [, sig] = token.split(".");
    // valid signature, different (unsigned) payload
    const fakePayload = btoa(JSON.stringify({ e: "attacker@evil.com" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const decoded = await verifyUnsubscribeToken(
      env as unknown as CloudflareBindings,
      `${fakePayload}.${sig}`,
    );
    expect(decoded).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const bindings = env as unknown as CloudflareBindings;
    expect(await verifyUnsubscribeToken(bindings, "")).toBeNull();
    expect(await verifyUnsubscribeToken(bindings, "no-dot")).toBeNull();
    expect(
      await verifyUnsubscribeToken(bindings, ".missing-payload"),
    ).toBeNull();
    expect(await verifyUnsubscribeToken(bindings, "missing-sig.")).toBeNull();
  });
});

describe("list-unsubscribe headers", () => {
  it("builds the two RFC-mandated headers pointing at BASE_URL/u/<token>", async () => {
    const headers = await buildListUnsubscribeHeaders(
      env as unknown as CloudflareBindings,
      { email: "x@example.com", sentEmailId: "sent-1" },
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toMatch(
      /^<http:\/\/localhost:8080\/u\/[^>]+>$/,
    );
  });
});

describe("public unsubscribe router", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("GET /u/<token> renders the confirmation page for a valid token", async () => {
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "user@example.com" },
    );
    const res = await workerExports.default.fetch(
      `http://localhost/u/${token}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user@example.com");
    expect(html).toContain('<form method="POST"');
  });

  it("GET /u/<bad> returns 400 with a helpful page", async () => {
    const res = await workerExports.default.fetch(
      "http://localhost/u/not-a-real-token",
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("inválido");
  });

  it("POST /u/<token> adds the email to the suppression list", async () => {
    const db = getDb();
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "drop@example.com", sentEmailId: "sent-99" },
    );
    const res = await workerExports.default.fetch(
      `http://localhost/u/${token}`,
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("drop@example.com");
    expect(html).toContain("ya no recibirá");

    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, "drop@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("unsubscribe");
    expect(rows[0].source).toBe("public-unsubscribe");
    expect(rows[0].sentEmailId).toBe("sent-99");
  });

  it("POST /u/<token> is idempotent (Gmail one-click may fire twice)", async () => {
    const db = getDb();
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "double@example.com" },
    );
    await workerExports.default.fetch(`http://localhost/u/${token}`, {
      method: "POST",
    });
    const res = await workerExports.default.fetch(
      `http://localhost/u/${token}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, "double@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("POST /u/<bad> returns 400 and does NOT touch the suppression list", async () => {
    const db = getDb();
    const res = await workerExports.default.fetch(
      "http://localhost/u/garbage.token",
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(400);
    const rows = await db.select().from(suppressions);
    expect(rows).toHaveLength(0);
  });

  it("requires no auth (no Authorization header sent)", async () => {
    const token = await signUnsubscribeToken(
      env as unknown as CloudflareBindings,
      { email: "anon@example.com" },
    );
    const res = await workerExports.default.fetch(
      `http://localhost/u/${token}`,
    );
    expect(res.status).toBe(200);
  });
});
