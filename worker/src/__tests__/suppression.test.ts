import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import {
  addSuppression,
  filterSuppressed,
  isSuppressed,
  listSuppressions,
  normalizeEmail,
  removeSuppression,
} from "../lib/suppression";
import { suppressions } from "../db/suppressions.schema";
import { eq } from "drizzle-orm";

describe("suppression helpers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  describe("normalizeEmail", () => {
    it("lowercases and trims", () => {
      expect(normalizeEmail("  Foo@Example.COM  ")).toBe("foo@example.com");
    });
  });

  describe("addSuppression + isSuppressed", () => {
    it("inserts a new suppression for an unknown email", async () => {
      const db = getDb();
      const result = await addSuppression(db, {
        email: "bounce@example.com",
        reason: "hard_bounce",
        source: "webhook:cf",
      });
      expect(result).toEqual({ inserted: true, updated: false });
      expect(await isSuppressed(db, "bounce@example.com")).toBe(true);
      expect(await isSuppressed(db, "other@example.com")).toBe(false);
    });

    it("treats canonicalized variants as the same row", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "Bounce@Example.com",
        reason: "hard_bounce",
      });
      const second = await addSuppression(db, {
        email: "  bounce@example.COM  ",
        reason: "hard_bounce",
      });
      expect(second).toEqual({ inserted: false, updated: false });
      expect(await isSuppressed(db, "bounce@example.com")).toBe(true);
    });

    it("upgrades reason when a more severe event arrives", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "u@example.com",
        reason: "unsubscribe",
      });
      const upgrade = await addSuppression(db, {
        email: "u@example.com",
        reason: "complaint",
        source: "webhook:resend",
      });
      expect(upgrade).toEqual({ inserted: false, updated: true });
      const [row] = await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "u@example.com"));
      expect(row.reason).toBe("complaint");
      expect(row.source).toBe("webhook:resend");
    });

    it("does NOT downgrade reason when a less severe event arrives", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "x@example.com",
        reason: "complaint",
        source: "webhook:resend",
      });
      const downgrade = await addSuppression(db, {
        email: "x@example.com",
        reason: "unsubscribe",
        source: "public-unsubscribe",
      });
      expect(downgrade).toEqual({ inserted: false, updated: false });
      const [row] = await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "x@example.com"));
      expect(row.reason).toBe("complaint");
      // source should not be downgraded either
      expect(row.source).toBe("webhook:resend");
    });

    it("serializes metadata objects to JSON", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "m@example.com",
        reason: "hard_bounce",
        metadata: { code: 550, message: "User unknown" },
      });
      const [row] = await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "m@example.com"));
      expect(row.metadata && JSON.parse(row.metadata)).toEqual({
        code: 550,
        message: "User unknown",
      });
    });

    it("throws on empty email", async () => {
      const db = getDb();
      await expect(
        addSuppression(db, { email: "   ", reason: "manual" }),
      ).rejects.toThrow(/empty email/);
    });
  });

  describe("filterSuppressed", () => {
    it("returns empty set for empty input", async () => {
      const db = getDb();
      const result = await filterSuppressed(db, []);
      expect(result.size).toBe(0);
    });

    it("returns only the suppressed subset", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "a@example.com",
        reason: "hard_bounce",
      });
      await addSuppression(db, {
        email: "b@example.com",
        reason: "unsubscribe",
      });
      const result = await filterSuppressed(db, [
        "A@example.com",
        "b@example.com",
        "c@example.com",
      ]);
      expect(result).toEqual(new Set(["a@example.com", "b@example.com"]));
    });
  });

  describe("removeSuppression", () => {
    it("removes the row (idempotent)", async () => {
      const db = getDb();
      await addSuppression(db, {
        email: "r@example.com",
        reason: "manual",
      });
      expect(await isSuppressed(db, "r@example.com")).toBe(true);
      await removeSuppression(db, "R@example.com");
      expect(await isSuppressed(db, "r@example.com")).toBe(false);
      // calling again on a missing email is a no-op, not an error
      await removeSuppression(db, "r@example.com");
    });
  });

  describe("listSuppressions", () => {
    it("paginates and sorts by createdAt desc", async () => {
      const db = getDb();
      for (const e of ["a@x.com", "b@x.com", "c@x.com"]) {
        await addSuppression(db, { email: e, reason: "manual" });
        // small wait to keep ordering deterministic at second-resolution
        await new Promise((r) => setTimeout(r, 1100));
      }
      const all = await listSuppressions(db, { limit: 10 });
      expect(all.map((r) => r.email)).toEqual([
        "c@x.com",
        "b@x.com",
        "a@x.com",
      ]);
      const page2 = await listSuppressions(db, { limit: 2, offset: 2 });
      expect(page2.length).toBe(1);
      expect(page2[0].email).toBe("a@x.com");
    }, 10_000);

    it("filters by reason", async () => {
      const db = getDb();
      await addSuppression(db, { email: "a@x.com", reason: "complaint" });
      await addSuppression(db, { email: "b@x.com", reason: "unsubscribe" });
      await addSuppression(db, { email: "c@x.com", reason: "complaint" });
      const onlyComplaints = await listSuppressions(db, {
        reason: "complaint",
      });
      expect(onlyComplaints.map((r) => r.email).sort()).toEqual([
        "a@x.com",
        "c@x.com",
      ]);
    });
  });
});
