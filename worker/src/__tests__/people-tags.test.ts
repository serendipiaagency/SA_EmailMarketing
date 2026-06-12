import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  authFetch,
  getDb,
} from "./helpers";
import {
  normalizeTag,
  addTag,
  removeTag,
  getTagsForPerson,
  listAllTags,
  personIdsByTag,
} from "../lib/people-tags";

describe("people-tags helpers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
    await createTestPerson({ id: "p1", email: "p1@x.com" });
    await createTestPerson({ id: "p2", email: "p2@x.com" });
  });

  describe("normalizeTag", () => {
    it("lowercases and trims", () => {
      expect(normalizeTag("  Customer  ")).toBe("customer");
    });
    it("rejects empty", () => {
      expect(normalizeTag("   ")).toBeNull();
    });
    it("rejects over-long tags", () => {
      expect(normalizeTag("x".repeat(65))).toBeNull();
    });
  });

  it("addTag is idempotent and case-insensitive", async () => {
    const db = getDb();
    await addTag(db, "p1", "Customer");
    await addTag(db, "p1", "customer");
    await addTag(db, "p1", "  CUSTOMER ");
    expect(await getTagsForPerson(db, "p1")).toEqual(["customer"]);
  });

  it("getTagsForPerson returns sorted tags", async () => {
    const db = getDb();
    await addTag(db, "p1", "zeta");
    await addTag(db, "p1", "alpha");
    await addTag(db, "p1", "mid");
    expect(await getTagsForPerson(db, "p1")).toEqual(["alpha", "mid", "zeta"]);
  });

  it("removeTag removes only the targeted tag", async () => {
    const db = getDb();
    await addTag(db, "p1", "a");
    await addTag(db, "p1", "b");
    await removeTag(db, "p1", "A");
    expect(await getTagsForPerson(db, "p1")).toEqual(["b"]);
  });

  it("listAllTags returns counts ordered by frequency", async () => {
    const db = getDb();
    await addTag(db, "p1", "customer");
    await addTag(db, "p2", "customer");
    await addTag(db, "p1", "vip");
    const all = await listAllTags(db);
    expect(all).toEqual([
      { tag: "customer", count: 2 },
      { tag: "vip", count: 1 },
    ]);
  });

  it("personIdsByTag returns matching contacts", async () => {
    const db = getDb();
    await addTag(db, "p1", "customer");
    await addTag(db, "p2", "customer");
    const ids = await personIdsByTag(db, "Customer");
    expect(ids.sort()).toEqual(["p1", "p2"]);
    expect(await personIdsByTag(db, "missing")).toEqual([]);
  });
});

describe("people tags router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({ id: "p1", email: "p1@x.com" });
  });

  it("POST /api/people/:id/tags adds a tag (201) and returns full list", async () => {
    const res = await authFetch("/api/people/p1/tags", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ tag: "Customer" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["customer"]);
  });

  it("GET /api/people/:id/tags lists tags", async () => {
    const db = getDb();
    await addTag(db, "p1", "vip");
    await addTag(db, "p1", "lead");
    const res = await authFetch("/api/people/p1/tags", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual(["lead", "vip"]);
  });

  it("DELETE /api/people/:id/tags removes a tag", async () => {
    const db = getDb();
    await addTag(db, "p1", "vip");
    const res = await authFetch("/api/people/p1/tags", {
      apiKey,
      method: "DELETE",
      body: JSON.stringify({ tag: "vip" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: string[] };
    expect(body.tags).toEqual([]);
  });

  it("returns 404 when tagging a nonexistent person", async () => {
    const res = await authFetch("/api/people/ghost/tags", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ tag: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/people/tags is not captured by /:id and returns counts", async () => {
    const db = getDb();
    await addTag(db, "p1", "customer");
    const res = await authFetch("/api/people/tags", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tags: Array<{ tag: string; count: number }>;
    };
    expect(body.tags).toEqual([{ tag: "customer", count: 1 }]);
  });
});
