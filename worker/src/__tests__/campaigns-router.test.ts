import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestTemplate,
  authFetch,
  getDb,
} from "./helpers";
import { addTag } from "../lib/people-tags";
import { addSuppression } from "../lib/suppression";
import { campaigns } from "../db/campaigns.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { emailEvents } from "../db/email-events.schema";

async function seedContacts(
  n: number,
  tag: string,
): Promise<{ id: string; email: string }[]> {
  const db = getDb();
  const out: { id: string; email: string }[] = [];
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    const email = `c${i}@x.com`;
    await createTestPerson({ id, email });
    await addTag(db, id, tag);
    out.push({ id, email });
  }
  return out;
}

describe("campaigns router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestTemplate({ slug: "promo" });
  });

  it("creates a campaign and enrolls all tagged non-suppressed contacts", async () => {
    const db = getDb();
    await seedContacts(3, "customer");

    const res = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Spring promo",
        templateSlug: "promo",
        fromAddress: "me@saasmail.test",
        tag: "customer",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      campaign: { id: string; totalRecipients: number; sequenceId: string };
      enrolled: number;
      skippedSuppressed: number;
      matched: number;
    };
    expect(body.matched).toBe(3);
    expect(body.enrolled).toBe(3);
    expect(body.skippedSuppressed).toBe(0);
    expect(body.campaign.totalRecipients).toBe(3);

    // 3 enrollments + 3 pending sequence emails on the backing sequence.
    const enrollments = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.sequenceId, body.campaign.sequenceId));
    expect(enrollments).toHaveLength(3);

    const emails = await db.select().from(sequenceEmails);
    expect(emails).toHaveLength(3);
    expect(emails.every((e) => e.status === "pending")).toBe(true);
  });

  it("skips suppressed contacts", async () => {
    const db = getDb();
    await seedContacts(3, "customer");
    await addSuppression(db, { email: "c1@x.com", reason: "complaint" });

    const res = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Promo",
        templateSlug: "promo",
        fromAddress: "me@saasmail.test",
        tag: "customer",
      }),
    });
    const body = (await res.json()) as {
      enrolled: number;
      skippedSuppressed: number;
      matched: number;
    };
    expect(body.matched).toBe(3);
    expect(body.enrolled).toBe(2);
    expect(body.skippedSuppressed).toBe(1);
  });

  it("returns 404 for a missing template", async () => {
    const res = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Promo",
        templateSlug: "does-not-exist",
        fromAddress: "me@saasmail.test",
        tag: "customer",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("handles an empty segment (0 recipients)", async () => {
    const res = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Promo",
        templateSlug: "promo",
        fromAddress: "me@saasmail.test",
        tag: "nobody-has-this",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { enrolled: number; matched: number };
    expect(body.matched).toBe(0);
    expect(body.enrolled).toBe(0);
  });

  it("lists campaigns newest-first", async () => {
    await seedContacts(1, "customer");
    await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "First",
        templateSlug: "promo",
        fromAddress: "me@saasmail.test",
        tag: "customer",
      }),
    });
    const res = await authFetch("/api/campaigns", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { campaigns: Array<{ name: string }> };
    expect(body.campaigns.length).toBeGreaterThanOrEqual(1);
    expect(body.campaigns[0].name).toBe("First");
  });

  it("aggregates engagement stats", async () => {
    const db = getDb();
    await seedContacts(2, "customer");
    const createRes = await authFetch("/api/campaigns", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Promo",
        templateSlug: "promo",
        fromAddress: "me@saasmail.test",
        tag: "customer",
      }),
    });
    const { campaign } = (await createRes.json()) as {
      campaign: { id: string; sequenceId: string };
    };

    // Simulate delivery: mark one outbox row sent with a sent_email_id, and
    // record an open + a click for it.
    const [firstEmail] = await db.select().from(sequenceEmails).limit(1);
    const sentId = nanoid();
    await db
      .update(sequenceEmails)
      .set({ status: "sent", sentAt: 1, sentEmailId: sentId })
      .where(eq(sequenceEmails.id, firstEmail.id));
    await db.insert(emailEvents).values([
      {
        id: nanoid(),
        sentEmailId: sentId,
        recipient: "c0@x.com",
        kind: "opened",
        url: null,
        userAgent: null,
        ipPrefix: null,
        eventAt: 2,
      },
      {
        id: nanoid(),
        sentEmailId: sentId,
        recipient: "c0@x.com",
        kind: "clicked",
        url: "https://x.com",
        userAgent: null,
        ipPrefix: null,
        eventAt: 3,
      },
    ]);

    const res = await authFetch(`/api/campaigns/${campaign.id}`, { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: {
        recipients: number;
        sent: number;
        pending: number;
        uniqueOpens: number;
        uniqueClicks: number;
      };
    };
    expect(body.stats.recipients).toBe(2);
    expect(body.stats.sent).toBe(1);
    expect(body.stats.pending).toBe(1);
    expect(body.stats.uniqueOpens).toBe(1);
    expect(body.stats.uniqueClicks).toBe(1);
  });

  it("returns 404 for an unknown campaign", async () => {
    const res = await authFetch("/api/campaigns/nope", { apiKey });
    expect(res.status).toBe(404);
  });
});
