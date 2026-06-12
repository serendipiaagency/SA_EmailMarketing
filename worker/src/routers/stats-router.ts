import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { emailEvents } from "../db/email-events.schema";
import { suppressions } from "../db/suppressions.schema";
import { json200Response } from "../lib/helpers";
import { inboxFilter } from "../lib/inbox-permissions";
import { assertInboxAllowed } from "../lib/inbox-permissions";
import type { Variables } from "../variables";

export const statsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const StatsSchema = z.object({
  totalPeople: z.number(),
  totalEmails: z.number(),
  unreadCount: z.number(),
  recipients: z.array(z.string()),
  senderIdentities: z.array(
    z.object({
      email: z.string(),
      displayName: z.string().nullable(),
      signatureHtml: z.string().nullable(),
    }),
  ),
});

const statsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Stats"],
  description:
    "Get inbox statistics (filtered to caller's accessible inboxes).",
  request: {
    query: z.object({
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
    }),
  },
  responses: {
    ...json200Response(StatsSchema, "Inbox statistics"),
  },
});

statsRouter.openapi(statsRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { recipient } = c.req.valid("query");

  const scopeFilter = inboxFilter(allowed, emails.recipient);
  const recipientFilter = recipient
    ? sql`${emails.recipient} = ${recipient}`
    : undefined;

  const whereEmails = and(scopeFilter, recipientFilter);

  const emailAgg = await db
    .select({
      total: sql<number>`COUNT(*)`,
      unread: sql<number>`SUM(CASE WHEN ${emails.isRead} = 0 THEN 1 ELSE 0 END)`,
    })
    .from(emails)
    .where(whereEmails ?? sql`1=1`);
  const totalEmails = emailAgg[0]?.total ?? 0;
  const unreadCount = emailAgg[0]?.unread ?? 0;

  const personCountRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(people)
    .where(
      allowed.isAdmin
        ? sql`1=1`
        : allowed.inboxes.length === 0
          ? sql`0`
          : sql`${people.id} IN (SELECT person_id FROM ${emails} WHERE ${emails.recipient} IN ${allowed.inboxes})`,
    );

  const allIdentities = await db.select().from(senderIdentities);
  const identityRows = allowed.isAdmin
    ? allIdentities
    : allIdentities.filter((r) => allowed.inboxes.includes(r.email));

  return c.json(
    {
      totalPeople: personCountRow[0]?.count ?? 0,
      totalEmails,
      unreadCount,
      recipients: identityRows.map((r) => r.email),
      senderIdentities: identityRows.map((r) => ({
        email: r.email,
        displayName: r.displayName,
        signatureHtml: r.signatureHtml,
      })),
    },
    200,
  );
});

// GET /api/stats/sent-email/{id} — per-message engagement stats.
const SentEmailStatsSchema = z.object({
  id: z.string(),
  status: z.string(),
  toAddress: z.string(),
  fromAddress: z.string(),
  sentAt: z.number(),
  opens: z.object({
    count: z.number(),
    firstAt: z.number().nullable(),
    lastAt: z.number().nullable(),
  }),
  clicks: z.object({
    count: z.number(),
    firstAt: z.number().nullable(),
    lastAt: z.number().nullable(),
    byUrl: z.array(z.object({ url: z.string(), count: z.number() })),
  }),
  suppression: z
    .object({
      reason: z.string(),
      since: z.number(),
      source: z.string().nullable(),
    })
    .nullable(),
});

const sentEmailStatsRoute = createRoute({
  method: "get",
  path: "/sent-email/{id}",
  tags: ["Stats"],
  description:
    "Per-message engagement: opens, clicks (with breakdown by URL), and current suppression status of the recipient.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(SentEmailStatsSchema, "Per-message engagement stats"),
  },
});

statsRouter.openapi(sentEmailStatsRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const allowed = c.get("allowedInboxes")!;

  const row = await db
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.id, id))
    .limit(1);
  if (row.length === 0) {
    return c.json({ error: "Sent email not found" }, 404);
  }
  const sent = row[0];
  // Scope: caller must have access to the from-address inbox.
  assertInboxAllowed(allowed, sent.fromAddress);

  const opensAgg = await db
    .select({
      count: sql<number>`COUNT(*)`,
      firstAt: sql<number | null>`MIN(${emailEvents.eventAt})`,
      lastAt: sql<number | null>`MAX(${emailEvents.eventAt})`,
    })
    .from(emailEvents)
    .where(
      and(eq(emailEvents.sentEmailId, id), eq(emailEvents.kind, "opened")),
    );

  const clicksAgg = await db
    .select({
      count: sql<number>`COUNT(*)`,
      firstAt: sql<number | null>`MIN(${emailEvents.eventAt})`,
      lastAt: sql<number | null>`MAX(${emailEvents.eventAt})`,
    })
    .from(emailEvents)
    .where(
      and(eq(emailEvents.sentEmailId, id), eq(emailEvents.kind, "clicked")),
    );

  const clicksByUrl = await db
    .select({
      url: emailEvents.url,
      count: sql<number>`COUNT(*)`,
    })
    .from(emailEvents)
    .where(
      and(eq(emailEvents.sentEmailId, id), eq(emailEvents.kind, "clicked")),
    )
    .groupBy(emailEvents.url);

  const suppressionRow = await db
    .select({
      reason: suppressions.reason,
      since: suppressions.createdAt,
      source: suppressions.source,
    })
    .from(suppressions)
    .where(eq(suppressions.email, sent.toAddress))
    .limit(1);

  return c.json(
    {
      id: sent.id,
      status: sent.status,
      toAddress: sent.toAddress,
      fromAddress: sent.fromAddress,
      sentAt: sent.sentAt,
      opens: {
        count: opensAgg[0]?.count ?? 0,
        firstAt: opensAgg[0]?.firstAt ?? null,
        lastAt: opensAgg[0]?.lastAt ?? null,
      },
      clicks: {
        count: clicksAgg[0]?.count ?? 0,
        firstAt: clicksAgg[0]?.firstAt ?? null,
        lastAt: clicksAgg[0]?.lastAt ?? null,
        byUrl: clicksByUrl
          .filter((r): r is { url: string; count: number } => r.url !== null)
          .map((r) => ({ url: r.url, count: r.count })),
      },
      suppression: suppressionRow[0]
        ? {
            reason: suppressionRow[0].reason,
            since: suppressionRow[0].since,
            source: suppressionRow[0].source,
          }
        : null,
    },
    200,
  );
});
