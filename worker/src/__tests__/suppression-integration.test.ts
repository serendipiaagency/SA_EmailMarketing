import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq, and } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  createTestTemplate,
  authFetch,
  getDb,
  buildSendForm,
} from "./helpers";
import { addSuppression } from "../lib/suppression";
import { sentEmails } from "../db/sent-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequences } from "../db/sequences.schema";
import { handleScheduled } from "../lib/sequence-processor";

describe("suppression — send-router integration", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    // Use DemoSender so we don't try to hit Resend in tests.
    (env as Record<string, unknown>).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as Record<string, unknown>).DEMO_MODE = "0";
  });

  it("returns 403 and skips sending when `to` is suppressed", async () => {
    const db = getDb();
    await addSuppression(db, {
      email: "blocked@example.com",
      reason: "complaint",
    });

    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "Blocked@Example.com",
        fromAddress: "me@saasmail.test",
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: string;
      suppressed: string[];
    };
    expect(body.error).toBe("suppressed_recipient");
    expect(body.suppressed).toEqual(["blocked@example.com"]);

    // Nothing should have been written to sent_emails.
    const rows = await db.select().from(sentEmails);
    expect(rows).toHaveLength(0);
  });

  it("returns 403 when any CC entry is suppressed", async () => {
    const db = getDb();
    await addSuppression(db, {
      email: "cc-blocked@example.com",
      reason: "unsubscribe",
    });

    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "ok@example.com",
        fromAddress: "me@saasmail.test",
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
        cc: [{ email: "cc-blocked@example.com", name: "X" }],
      }),
    });

    expect(res.status).toBe(403);
    const rows = await db.select().from(sentEmails);
    expect(rows).toHaveLength(0);
  });

  it("does not block a non-suppressed recipient", async () => {
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "fine@example.com",
        fromAddress: "me@saasmail.test",
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 on reply if the original recipient is now suppressed", async () => {
    const db = getDb();
    await createTestPerson({
      id: "p-supp",
      email: "supp@example.com",
    });
    await createTestEmail({
      id: "e-supp",
      personId: "p-supp",
      recipient: "inbox@saasmail.test",
    });
    await addSuppression(db, {
      email: "supp@example.com",
      reason: "hard_bounce",
    });

    const res = await authFetch("/api/send/reply/e-supp", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "me@saasmail.test",
        bodyHtml: "<p>Reply body</p>",
      }),
    });

    expect(res.status).toBe(403);
  });
});

describe("suppression — sequence-processor integration", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("cancels the email + enrollment + remaining steps when person is suppressed", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    await createTestPerson({ id: "p-1", email: "drop@example.com" });
    await createTestTemplate({ slug: "welcome" });

    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
        { order: 2, templateSlug: "welcome", delayHours: 24 },
      ]),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "p-1",
      status: "active",
      variables: "{}",
      fromAddress: "me@saasmail.test",
      enrolledAt: now,
    });

    await db.insert(sequenceEmails).values([
      {
        id: "se-1",
        enrollmentId: "enr-1",
        stepOrder: 1,
        templateSlug: "welcome",
        scheduledAt: now,
        status: "pending",
      },
      {
        id: "se-2",
        enrollmentId: "enr-1",
        stepOrder: 2,
        templateSlug: "welcome",
        scheduledAt: now + 3600,
        status: "pending",
      },
    ]);

    await addSuppression(db, {
      email: "drop@example.com",
      reason: "complaint",
    });

    // Cron-driven inline processing (no queue): handleScheduled claims the
    // due email, processSequenceEmail sees the suppression and cancels.
    await handleScheduled(env as unknown as CloudflareBindings);

    const se1 = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    expect(se1[0].status).toBe("cancelled");

    const se2 = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-2"));
    expect(se2[0].status).toBe("cancelled");

    const [enr] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-1"));
    expect(enr.status).toBe("cancelled");
    expect(enr.cancelledAt).toBeTruthy();

    // No sent_emails row should have been written.
    const sent = await db
      .select()
      .from(sentEmails)
      .where(
        and(
          eq(sentEmails.fromAddress, "me@saasmail.test"),
          eq(sentEmails.toAddress, "drop@example.com"),
        ),
      );
    expect(sent).toHaveLength(0);
  });
});
