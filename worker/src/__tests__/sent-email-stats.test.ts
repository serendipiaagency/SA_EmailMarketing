import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { nanoid } from "nanoid";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  authFetch,
  getDb,
} from "./helpers";
import { sentEmails } from "../db/sent-emails.schema";
import { emailEvents } from "../db/email-events.schema";
import { addSuppression } from "../lib/suppression";

async function seedSent(opts: {
  id: string;
  fromAddress?: string;
  toAddress?: string;
}): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(sentEmails).values({
    id: opts.id,
    fromAddress: opts.fromAddress ?? "me@saasmail.test",
    toAddress: opts.toAddress ?? "you@example.com",
    subject: "Hi",
    bodyHtml: "<p>Hi</p>",
    bodyText: null,
    messageId: `mid-${opts.id}`,
    resendId: null,
    status: "sent",
    sentAt: now,
    createdAt: now,
  });
}

async function recordEvent(opts: {
  sentEmailId: string;
  kind: "opened" | "clicked";
  recipient?: string;
  url?: string;
  eventAt?: number;
}): Promise<void> {
  const db = getDb();
  await db.insert(emailEvents).values({
    id: nanoid(),
    sentEmailId: opts.sentEmailId,
    recipient: opts.recipient ?? "you@example.com",
    kind: opts.kind,
    url: opts.url ?? null,
    userAgent: "test",
    ipPrefix: null,
    eventAt: opts.eventAt ?? Math.floor(Date.now() / 1000),
  });
}

describe("GET /api/stats/sent-email/:id", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({ id: "p1", email: "you@example.com" });
  });

  it("returns 404 for unknown id", async () => {
    const res = await authFetch("/api/stats/sent-email/nope", { apiKey });
    expect(res.status).toBe(404);
  });

  it("reports zero engagement for a fresh send", async () => {
    await seedSent({ id: "se-1" });
    const res = await authFetch("/api/stats/sent-email/se-1", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      opens: { count: number };
      clicks: { count: number; byUrl: unknown[] };
      suppression: unknown;
    };
    expect(body.opens.count).toBe(0);
    expect(body.clicks.count).toBe(0);
    expect(body.clicks.byUrl).toEqual([]);
    expect(body.suppression).toBeNull();
  });

  it("aggregates open events", async () => {
    await seedSent({ id: "se-open" });
    const now = Math.floor(Date.now() / 1000);
    await recordEvent({ sentEmailId: "se-open", kind: "opened", eventAt: now });
    await recordEvent({
      sentEmailId: "se-open",
      kind: "opened",
      eventAt: now + 10,
    });
    await recordEvent({
      sentEmailId: "se-open",
      kind: "opened",
      eventAt: now + 100,
    });

    const res = await authFetch("/api/stats/sent-email/se-open", { apiKey });
    const body = (await res.json()) as {
      opens: { count: number; firstAt: number; lastAt: number };
    };
    expect(body.opens.count).toBe(3);
    expect(body.opens.firstAt).toBe(now);
    expect(body.opens.lastAt).toBe(now + 100);
  });

  it("aggregates click events with byUrl breakdown", async () => {
    await seedSent({ id: "se-click" });
    await recordEvent({
      sentEmailId: "se-click",
      kind: "clicked",
      url: "https://example.com/a",
    });
    await recordEvent({
      sentEmailId: "se-click",
      kind: "clicked",
      url: "https://example.com/a",
    });
    await recordEvent({
      sentEmailId: "se-click",
      kind: "clicked",
      url: "https://example.com/b",
    });

    const res = await authFetch("/api/stats/sent-email/se-click", { apiKey });
    const body = (await res.json()) as {
      clicks: { count: number; byUrl: Array<{ url: string; count: number }> };
    };
    expect(body.clicks.count).toBe(3);
    const sorted = [...body.clicks.byUrl].sort((a, b) =>
      a.url.localeCompare(b.url),
    );
    expect(sorted).toEqual([
      { url: "https://example.com/a", count: 2 },
      { url: "https://example.com/b", count: 1 },
    ]);
  });

  it("includes current suppression status for the recipient", async () => {
    const db = getDb();
    await seedSent({ id: "se-supp", toAddress: "bounced@example.com" });
    await addSuppression(db, {
      email: "bounced@example.com",
      reason: "hard_bounce",
      source: "inbound-dsn",
    });

    const res = await authFetch("/api/stats/sent-email/se-supp", { apiKey });
    const body = (await res.json()) as {
      suppression: { reason: string; source: string };
    };
    expect(body.suppression.reason).toBe("hard_bounce");
    expect(body.suppression.source).toBe("inbound-dsn");
  });
});
