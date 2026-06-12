import { eq, sql, desc, and, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { suppressions } from "../db/suppressions.schema";
import type { Variables } from "../variables";

export type SuppressionReason =
  | "hard_bounce"
  | "soft_bounce_repeated"
  | "complaint"
  | "unsubscribe"
  | "manual"
  | "invalid";

export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "hard_bounce",
  "soft_bounce_repeated",
  "complaint",
  "unsubscribe",
  "manual",
  "invalid",
] as const;

// Severity ranking. A higher-severity reason supersedes a lower one on
// upsert; a lower-severity event never downgrades an existing entry.
const SEVERITY: Record<SuppressionReason, number> = {
  complaint: 5,
  hard_bounce: 4,
  invalid: 3,
  soft_bounce_repeated: 2,
  unsubscribe: 1,
  manual: 0,
};

type Db = Variables["db"];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function isSuppressed(db: Db, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const row = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(eq(suppressions.email, normalized))
    .limit(1);
  return row.length > 0;
}

// Bulk check — returns the subset of the input that is currently suppressed.
// Cheaper than N round-trips when fanning out to a list.
export async function filterSuppressed(
  db: Db,
  emails: string[],
): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const normalized = Array.from(
    new Set(emails.map(normalizeEmail).filter(Boolean)),
  );
  if (normalized.length === 0) return new Set();
  const rows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(sql`${suppressions.email} IN (${sql.join(normalized, sql`, `)})`);
  return new Set(rows.map((r) => r.email));
}

export interface AddSuppressionInput {
  email: string;
  reason: SuppressionReason;
  source?: string | null;
  sentEmailId?: string | null;
  metadata?: unknown;
}

// Idempotent upsert keyed by email. Lower-severity reasons do not
// overwrite higher-severity existing entries — once "complaint", never
// downgrade to "unsubscribe". updatedAt always advances.
export async function addSuppression(
  db: Db,
  input: AddSuppressionInput,
): Promise<{ inserted: boolean; updated: boolean }> {
  const email = normalizeEmail(input.email);
  if (!email) {
    throw new Error("addSuppression: empty email");
  }
  const now = Math.floor(Date.now() / 1000);
  const metadataStr =
    input.metadata === undefined || input.metadata === null
      ? null
      : typeof input.metadata === "string"
        ? input.metadata
        : JSON.stringify(input.metadata);

  const existing = await db
    .select({
      id: suppressions.id,
      reason: suppressions.reason,
    })
    .from(suppressions)
    .where(eq(suppressions.email, email))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(suppressions).values({
      id: nanoid(),
      email,
      reason: input.reason,
      source: input.source ?? null,
      sentEmailId: input.sentEmailId ?? null,
      metadata: metadataStr,
      createdAt: now,
      updatedAt: now,
    });
    return { inserted: true, updated: false };
  }

  const current = existing[0];
  const currentReason = current.reason as SuppressionReason;
  const incomingSeverity = SEVERITY[input.reason] ?? -1;
  const currentSeverity = SEVERITY[currentReason] ?? -1;

  if (incomingSeverity > currentSeverity) {
    await db
      .update(suppressions)
      .set({
        reason: input.reason,
        source: input.source ?? null,
        sentEmailId: input.sentEmailId ?? null,
        metadata: metadataStr,
        updatedAt: now,
      })
      .where(eq(suppressions.id, current.id));
    return { inserted: false, updated: true };
  }

  // Same or lower severity: just bump updatedAt so the row reflects
  // the most recent event without losing the stronger reason.
  await db
    .update(suppressions)
    .set({ updatedAt: now })
    .where(eq(suppressions.id, current.id));
  return { inserted: false, updated: false };
}

export async function removeSuppression(
  db: Db,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const result = await db
    .delete(suppressions)
    .where(eq(suppressions.email, normalized));
  // d1 returns { meta: { changes } } — drizzle exposes it via .returning() too.
  // We don't rely on rowsAffected here; the caller just needs idempotency.
  return Boolean(result);
}

export interface ListSuppressionsOptions {
  limit?: number;
  offset?: number;
  reason?: SuppressionReason;
}

export async function listSuppressions(
  db: Db,
  opts: ListSuppressionsOptions = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions: SQL[] = [];
  if (opts.reason) conditions.push(eq(suppressions.reason, opts.reason));

  const where =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions);

  const rows = where
    ? await db
        .select()
        .from(suppressions)
        .where(where)
        .orderBy(desc(suppressions.createdAt))
        .limit(limit)
        .offset(offset)
    : await db
        .select()
        .from(suppressions)
        .orderBy(desc(suppressions.createdAt))
        .limit(limit)
        .offset(offset);

  return rows;
}
