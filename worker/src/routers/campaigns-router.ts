import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { campaigns } from "../db/campaigns.schema";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { people } from "../db/people.schema";
import { json200Response, json201Response } from "../lib/helpers";
import { assertInboxAllowed } from "../lib/inbox-permissions";
import { personIdsByTag } from "../lib/people-tags";
import { filterSuppressed } from "../lib/suppression";
import type { Variables } from "../variables";

export const campaignsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  templateSlug: z.string(),
  fromAddress: z.string(),
  tag: z.string().nullable(),
  sequenceId: z.string(),
  totalRecipients: z.number(),
  createdAt: z.number(),
});

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// POST /api/campaigns — create + send a broadcast to a tag segment.
const createCampaignRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Campaigns"],
  description:
    "Create a campaign: enroll every non-suppressed contact carrying `tag` into a one-step sequence using `templateSlug`. Delivery is handled by the cron (throttled). Returns the campaign plus how many were enrolled vs skipped.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(200),
            templateSlug: z.string().min(1),
            fromAddress: z.string().email(),
            tag: z.string().min(1).max(64),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        campaign: CampaignSchema,
        enrolled: z.number(),
        skippedSuppressed: z.number(),
        matched: z.number(),
      }),
      "Campaign created",
    ),
  },
});

campaignsRouter.openapi(createCampaignRoute, async (c) => {
  const db = c.get("db");
  const { name, templateSlug, fromAddress: rawFrom, tag } = c.req.valid("json");
  const fromAddress = rawFrom.trim().toLowerCase();
  const allowed = c.get("allowedInboxes")!;
  assertInboxAllowed(allowed, fromAddress);

  // Template must exist.
  const tmpl = await db
    .select({ slug: emailTemplates.slug })
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, templateSlug))
    .limit(1);
  if (tmpl.length === 0) {
    return c.json({ error: "Template not found" }, 404);
  }

  const now = Math.floor(Date.now() / 1000);

  // Resolve the segment, then drop suppressed recipients.
  const matchedIds = await personIdsByTag(db, tag);
  let eligible: { id: string; email: string }[] = [];
  let skippedSuppressed = 0;
  if (matchedIds.length > 0) {
    const rows: { id: string; email: string }[] = [];
    for (const ids of chunk(matchedIds, 100)) {
      const r = await db
        .select({ id: people.id, email: people.email })
        .from(people)
        .where(inArray(people.id, ids));
      rows.push(...r);
    }
    const suppressed = await filterSuppressed(
      db,
      rows.map((r) => r.email),
    );
    for (const r of rows) {
      if (suppressed.has(r.email.toLowerCase())) skippedSuppressed++;
      else eligible.push(r);
    }
  }

  // One-step sequence backs the campaign.
  const sequenceId = nanoid();
  await db.insert(sequences).values({
    id: sequenceId,
    name: `[campaign] ${name}`,
    steps: JSON.stringify([{ order: 1, templateSlug, delayHours: 0 }]),
    createdAt: now,
    updatedAt: now,
  });

  // Bulk-enroll. Rows are "pending" + due now; the cron dispatches them
  // (inline send would risk timeouts on large segments).
  for (const group of chunk(eligible, 50)) {
    const enrollRows = group.map((p) => ({
      id: nanoid(),
      sequenceId,
      personId: p.id,
      status: "active" as const,
      variables: "{}",
      fromAddress,
      enrolledAt: now,
      cancelledAt: null,
    }));
    await db.insert(sequenceEnrollments).values(enrollRows);
    await db.insert(sequenceEmails).values(
      enrollRows.map((e) => ({
        id: nanoid(),
        enrollmentId: e.id,
        stepOrder: 1,
        templateSlug,
        scheduledAt: now,
        status: "pending" as const,
        sentAt: null,
        sentEmailId: null,
      })),
    );
  }

  const campaignId = nanoid();
  const campaignRow = {
    id: campaignId,
    name,
    templateSlug,
    fromAddress,
    tag,
    sequenceId,
    totalRecipients: eligible.length,
    createdAt: now,
  };
  await db.insert(campaigns).values(campaignRow);

  return c.json(
    {
      campaign: campaignRow,
      enrolled: eligible.length,
      skippedSuppressed,
      matched: matchedIds.length,
    },
    201,
  );
});

// GET /api/campaigns — list campaigns, newest first.
const listCampaignsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Campaigns"],
  description: "List campaigns, newest first.",
  responses: {
    ...json200Response(
      z.object({ campaigns: z.array(CampaignSchema) }),
      "Campaigns",
    ),
  },
});

campaignsRouter.openapi(listCampaignsRoute, async (c) => {
  const db = c.get("db");
  const rows = await db
    .select()
    .from(campaigns)
    .orderBy(desc(campaigns.createdAt))
    .limit(200);
  return c.json({ campaigns: rows }, 200);
});

// GET /api/campaigns/:id — campaign detail + aggregated engagement.
const getCampaignRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Campaigns"],
  description:
    "Campaign detail with delivery + engagement stats aggregated across all recipients.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        campaign: CampaignSchema,
        stats: z.object({
          recipients: z.number(),
          sent: z.number(),
          failed: z.number(),
          pending: z.number(),
          cancelled: z.number(),
          uniqueOpens: z.number(),
          uniqueClicks: z.number(),
        }),
      }),
      "Campaign with stats",
    ),
  },
});

campaignsRouter.openapi(getCampaignRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, id))
    .limit(1);
  if (rows.length === 0) {
    return c.json({ error: "Campaign not found" }, 404);
  }
  const campaign = rows[0];

  // Status breakdown over the backing sequence's outbox rows.
  const statusRows = await db
    .select({
      status: sequenceEmails.status,
      count: sql<number>`COUNT(*)`,
    })
    .from(sequenceEmails)
    .innerJoin(
      sequenceEnrollments,
      eq(sequenceEmails.enrollmentId, sequenceEnrollments.id),
    )
    .where(eq(sequenceEnrollments.sequenceId, campaign.sequenceId))
    .groupBy(sequenceEmails.status);

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.count;

  // Engagement: distinct recipients who opened / clicked any of the
  // campaign's sent emails.
  const sentEmailIdRows = await db
    .select({ sentEmailId: sequenceEmails.sentEmailId })
    .from(sequenceEmails)
    .innerJoin(
      sequenceEnrollments,
      eq(sequenceEmails.enrollmentId, sequenceEnrollments.id),
    )
    .where(
      and(
        eq(sequenceEnrollments.sequenceId, campaign.sequenceId),
        sql`${sequenceEmails.sentEmailId} IS NOT NULL`,
      ),
    );
  const sentIds = sentEmailIdRows
    .map((r) => r.sentEmailId)
    .filter((v): v is string => v !== null);

  let uniqueOpens = 0;
  let uniqueClicks = 0;
  if (sentIds.length > 0) {
    const [openAgg] = await db.all<{ c: number }>(sql`
      SELECT COUNT(DISTINCT recipient) AS c FROM email_events
      WHERE kind = 'opened' AND sent_email_id IN (${sql.join(sentIds, sql`, `)})
    `);
    const [clickAgg] = await db.all<{ c: number }>(sql`
      SELECT COUNT(DISTINCT recipient) AS c FROM email_events
      WHERE kind = 'clicked' AND sent_email_id IN (${sql.join(sentIds, sql`, `)})
    `);
    uniqueOpens = openAgg?.c ?? 0;
    uniqueClicks = clickAgg?.c ?? 0;
  }

  return c.json(
    {
      campaign,
      stats: {
        recipients: campaign.totalRecipients,
        sent: byStatus["sent"] ?? 0,
        failed: byStatus["failed"] ?? 0,
        pending: (byStatus["pending"] ?? 0) + (byStatus["queued"] ?? 0),
        cancelled: byStatus["cancelled"] ?? 0,
        uniqueOpens,
        uniqueClicks,
      },
    },
    200,
  );
});
