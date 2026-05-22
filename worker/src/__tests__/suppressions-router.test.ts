import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { addSuppression } from "../lib/suppression";

describe("admin suppressions router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/admin/suppressions", () => {
    it("returns paginated rows newest-first", async () => {
      const db = getDb();
      await addSuppression(db, { email: "a@x.com", reason: "manual" });
      await new Promise((r) => setTimeout(r, 1100));
      await addSuppression(db, { email: "b@x.com", reason: "complaint" });

      const res = await authFetch("/api/admin/suppressions", { apiKey });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: Array<{ email: string; reason: string }>;
        limit: number;
        offset: number;
      };
      expect(body.rows.map((r) => r.email)).toEqual(["b@x.com", "a@x.com"]);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
    }, 5_000);

    it("filters by reason", async () => {
      const db = getDb();
      await addSuppression(db, { email: "a@x.com", reason: "complaint" });
      await addSuppression(db, { email: "b@x.com", reason: "unsubscribe" });

      const res = await authFetch("/api/admin/suppressions?reason=complaint", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rows: Array<{ email: string; reason: string }>;
      };
      expect(body.rows.map((r) => r.email)).toEqual(["a@x.com"]);
    });

    it("rejects forbidden requests from non-admin users", async () => {
      // Replace the admin user with a regular one.
      await cleanDb();
      const { apiKey: memberKey } = await createTestUser({ role: "member" });
      const res = await authFetch("/api/admin/suppressions", {
        apiKey: memberKey,
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/admin/suppressions/check", () => {
    it("returns suppressed=true for a known email (case-insensitive)", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "known@x.com",
        reason: "hard_bounce",
        source: "webhook:cf",
      });

      const res = await authFetch(
        "/api/admin/suppressions/check?email=KNOWN%40x.com",
        { apiKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        suppressed: boolean;
        row: { email: string; reason: string; source: string | null };
      };
      expect(body.suppressed).toBe(true);
      expect(body.row.email).toBe("known@x.com");
      expect(body.row.reason).toBe("hard_bounce");
      expect(body.row.source).toBe("webhook:cf");
    });

    it("returns suppressed=false for an unknown email", async () => {
      const res = await authFetch(
        "/api/admin/suppressions/check?email=nobody%40x.com",
        { apiKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        suppressed: boolean;
        row: null;
      };
      expect(body.suppressed).toBe(false);
      expect(body.row).toBeNull();
    });
  });

  describe("POST /api/admin/suppressions", () => {
    it("inserts a new row", async () => {
      const res = await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          email: "manual@x.com",
          reason: "manual",
          source: "ticket-1234",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        inserted: boolean;
        updated: boolean;
      };
      expect(body.inserted).toBe(true);
      expect(body.updated).toBe(false);

      const check = await authFetch(
        "/api/admin/suppressions/check?email=manual%40x.com",
        { apiKey },
      );
      const checkBody = (await check.json()) as {
        suppressed: boolean;
        row: { source: string | null } | null;
      };
      expect(checkBody.suppressed).toBe(true);
      expect(checkBody.row?.source).toBe("ticket-1234");
    });

    it("upgrades reason on second POST with higher severity", async () => {
      await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          email: "up@x.com",
          reason: "unsubscribe",
        }),
      });
      const res = await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          email: "up@x.com",
          reason: "complaint",
        }),
      });
      const body = (await res.json()) as {
        inserted: boolean;
        updated: boolean;
      };
      expect(body.updated).toBe(true);
    });

    it("rejects invalid email format with 400", async () => {
      const res = await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ email: "not-an-email", reason: "manual" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects unknown reason with 400", async () => {
      const res = await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ email: "ok@x.com", reason: "made_up" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/admin/suppressions", () => {
    it("removes a row by email", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "tokill@x.com",
        reason: "manual",
      });
      const res = await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "DELETE",
        body: JSON.stringify({ email: "tokill@x.com" }),
      });
      expect(res.status).toBe(200);

      const check = await authFetch(
        "/api/admin/suppressions/check?email=tokill%40x.com",
        { apiKey },
      );
      const checkBody = (await check.json()) as { suppressed: boolean };
      expect(checkBody.suppressed).toBe(false);
    });

    it("is idempotent on missing emails", async () => {
      const res = await authFetch("/api/admin/suppressions", {
        apiKey,
        method: "DELETE",
        body: JSON.stringify({ email: "nope@x.com" }),
      });
      expect(res.status).toBe(200);
    });
  });
});
