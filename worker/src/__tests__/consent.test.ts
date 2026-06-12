import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  authFetch,
  getDb,
} from "./helpers";
import { recordConsent, revokeConsent, getConsentStatus } from "../lib/consent";

describe("consent helpers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
    await createTestPerson({ id: "p1", email: "p1@x.com" });
  });

  it("records consent and reports active status", async () => {
    const db = getDb();
    await recordConsent(db, {
      personId: "p1",
      source: "form",
      basis: "consent",
      note: "signup form",
    });
    const status = await getConsentStatus(db, "p1");
    expect(status.hasActiveConsent).toBe(true);
    expect(status.history).toHaveLength(1);
    expect(status.history[0].source).toBe("form");
  });

  it("revokeConsent stamps revokedAt and flips status", async () => {
    const db = getDb();
    await recordConsent(db, {
      personId: "p1",
      source: "form",
      basis: "consent",
    });
    const revoked = await revokeConsent(db, "p1");
    expect(revoked).toBe(1);
    const status = await getConsentStatus(db, "p1");
    expect(status.hasActiveConsent).toBe(false);
    expect(status.history[0].revokedAt).toBeTruthy();
  });

  it("a fresh contact has no active consent", async () => {
    const db = getDb();
    const status = await getConsentStatus(db, "p1");
    expect(status.hasActiveConsent).toBe(false);
    expect(status.history).toHaveLength(0);
  });

  it("re-consent after revoke makes status active again", async () => {
    const db = getDb();
    await recordConsent(db, {
      personId: "p1",
      source: "form",
      basis: "consent",
    });
    await revokeConsent(db, "p1");
    await recordConsent(db, {
      personId: "p1",
      source: "manual",
      basis: "consent",
    });
    const status = await getConsentStatus(db, "p1");
    expect(status.hasActiveConsent).toBe(true);
    expect(status.history).toHaveLength(2);
  });
});

describe("consent router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({ id: "p1", email: "p1@x.com" });
  });

  it("POST /api/people/:id/consent records and returns status", async () => {
    const res = await authFetch("/api/people/p1/consent", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        source: "form",
        basis: "consent",
        note: "newsletter signup",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      hasActiveConsent: boolean;
      history: Array<{ source: string; basis: string }>;
    };
    expect(body.hasActiveConsent).toBe(true);
    expect(body.history[0].source).toBe("form");
    expect(body.history[0].basis).toBe("consent");
  });

  it("rejects an invalid legal basis (400)", async () => {
    const res = await authFetch("/api/people/p1/consent", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ source: "form", basis: "made_up" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/people/:id/consent returns history", async () => {
    const db = getDb();
    await recordConsent(db, {
      personId: "p1",
      source: "import",
      basis: "legitimate_interest",
    });
    const res = await authFetch("/api/people/p1/consent", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasActiveConsent: boolean;
      history: unknown[];
    };
    expect(body.hasActiveConsent).toBe(true);
    expect(body.history).toHaveLength(1);
  });

  it("DELETE /api/people/:id/consent withdraws consent", async () => {
    const db = getDb();
    await recordConsent(db, {
      personId: "p1",
      source: "form",
      basis: "consent",
    });
    const res = await authFetch("/api/people/p1/consent", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revoked: number;
      status: { hasActiveConsent: boolean };
    };
    expect(body.revoked).toBe(1);
    expect(body.status.hasActiveConsent).toBe(false);
  });

  it("returns 404 for a nonexistent contact", async () => {
    const res = await authFetch("/api/people/ghost/consent", { apiKey });
    expect(res.status).toBe(404);
  });
});
