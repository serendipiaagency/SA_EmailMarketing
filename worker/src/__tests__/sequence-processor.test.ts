import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestTemplate,
  getDb,
} from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { eq } from "drizzle-orm";
import { handleScheduled } from "../lib/sequence-processor";
import { addSuppression } from "../lib/suppression";

const bindings = env as unknown as CloudflareBindings;

// Insert a sequence + active enrollment, returning the enrollment id.
async function seedEnrollment(opts: {
  personId: string;
  email: string;
  templateSlug: string;
}): Promise<string> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await createTestPerson({ id: opts.personId, email: opts.email });
  await db.insert(sequences).values({
    id: "seq-1",
    name: "Test",
    steps: JSON.stringify([
      { order: 1, templateSlug: opts.templateSlug, delayHours: 0 },
    ]),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sequenceEnrollments).values({
    id: "enr-1",
    sequenceId: "seq-1",
    personId: opts.personId,
    status: "active",
    variables: "{}",
    fromAddress: "test@test.com",
    enrolledAt: now,
  });
  return "enr-1";
}

describe("sequence processor — handleScheduled (inline, no queue)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("processes a due pending email inline (missing template -> failed)", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    // Note: NO template created — processSequenceEmail marks the row failed
    // before reaching the sender, which is deterministic in tests.
    await seedEnrollment({
      personId: "s1",
      email: "a@test.com",
      templateSlug: "welcome",
    });
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "pending",
    });

    await handleScheduled(bindings);

    const [row] = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    // Was claimed + processed inline; not left pending/queued.
    expect(row.status).toBe("failed");
  });

  it("cancels a due email when the recipient is suppressed", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await seedEnrollment({
      personId: "s1",
      email: "blocked@test.com",
      templateSlug: "welcome",
    });
    await createTestTemplate({ slug: "welcome" });
    await addSuppression(db, {
      email: "blocked@test.com",
      reason: "complaint",
    });
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "pending",
    });

    await handleScheduled(bindings);

    const [row] = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    expect(row.status).toBe("cancelled");

    const [enr] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-1"));
    expect(enr.status).toBe("cancelled");
  });

  it("does not process future-scheduled pending emails", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await seedEnrollment({
      personId: "s1",
      email: "a@test.com",
      templateSlug: "welcome",
    });
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now + 99999,
      status: "pending",
    });

    await handleScheduled(bindings);

    const [row] = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    expect(row.status).toBe("pending");
  });

  it("does nothing when there are no due pending emails", async () => {
    await handleScheduled(bindings);
  });
});
