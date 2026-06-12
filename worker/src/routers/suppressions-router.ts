import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { suppressions } from "../db/suppressions.schema";
import { json200Response, json201Response } from "../lib/helpers";
import {
  SUPPRESSION_REASONS,
  addSuppression,
  listSuppressions,
  normalizeEmail,
  removeSuppression,
  type SuppressionReason,
} from "../lib/suppression";
import type { Variables } from "../variables";

export const suppressionsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ReasonEnum = z.enum(
  SUPPRESSION_REASONS as unknown as [string, ...string[]],
);

const SuppressionRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  reason: ReasonEnum,
  source: z.string().nullable(),
  sentEmailId: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// GET /api/admin/suppressions — list with optional filter + pagination.
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Suppressions"],
  description:
    "List entries in the active suppression list, newest first. Filter by reason and paginate with limit/offset.",
  request: {
    query: z.object({
      reason: ReasonEnum.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        rows: z.array(SuppressionRowSchema),
        limit: z.number(),
        offset: z.number(),
      }),
      "Suppression list page",
    ),
  },
});

suppressionsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const q = c.req.valid("query");
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  const rows = await listSuppressions(db, {
    limit,
    offset,
    reason: q.reason as SuppressionReason | undefined,
  });
  return c.json(
    {
      rows: rows.map((r) => ({
        ...r,
        reason: r.reason as SuppressionReason,
      })),
      limit,
      offset,
    },
    200,
  );
});

// GET /api/admin/suppressions/check?email=… — point lookup.
const checkRoute = createRoute({
  method: "get",
  path: "/check",
  tags: ["Suppressions"],
  description:
    "Check whether a single email address is currently on the suppression list.",
  request: {
    query: z.object({
      email: z.string().email(),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        suppressed: z.boolean(),
        row: SuppressionRowSchema.nullable(),
      }),
      "Suppression status for the given email",
    ),
  },
});

suppressionsRouter.openapi(checkRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("query");
  const normalized = normalizeEmail(email);
  const row = await db
    .select()
    .from(suppressions)
    .where(eq(suppressions.email, normalized))
    .limit(1);
  if (row.length === 0) {
    return c.json({ suppressed: false, row: null }, 200);
  }
  const r = row[0];
  return c.json(
    {
      suppressed: true,
      row: { ...r, reason: r.reason as SuppressionReason },
    },
    200,
  );
});

// POST /api/admin/suppressions — manually add an entry.
const AddBodySchema = z.object({
  email: z.string().email(),
  reason: ReasonEnum,
  source: z.string().max(200).optional(),
  metadata: z.unknown().optional(),
});

const addRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Suppressions"],
  description:
    "Add an address to the suppression list. Idempotent: a more severe reason supersedes a less severe one; a less severe reason never downgrades an existing entry.",
  request: {
    body: {
      content: {
        "application/json": { schema: AddBodySchema },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        inserted: z.boolean(),
        updated: z.boolean(),
      }),
      "Suppression upserted",
    ),
  },
});

suppressionsRouter.openapi(addRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const result = await addSuppression(db, {
    email: body.email,
    reason: body.reason as SuppressionReason,
    source: body.source ?? "admin",
    metadata: body.metadata,
  });
  return c.json(result, 201);
});

// DELETE /api/admin/suppressions — remove an entry by email.
const DeleteBodySchema = z.object({
  email: z.string().email(),
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Suppressions"],
  description:
    "Remove an address from the suppression list (re-allow sends). Idempotent: removing a missing address is not an error.",
  request: {
    body: {
      content: {
        "application/json": { schema: DeleteBodySchema },
      },
    },
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Removed"),
  },
});

suppressionsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("json");
  await removeSuppression(db, email);
  return c.json({ success: true }, 200);
});
