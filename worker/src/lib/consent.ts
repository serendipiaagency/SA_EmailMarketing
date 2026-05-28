import { eq, and, isNull, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { consents } from "../db/consents.schema";
import type { Variables } from "../variables";

type Db = Variables["db"];

export const CONSENT_SOURCES = [
  "manual",
  "import",
  "form",
  "double_opt_in",
  "api",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const CONSENT_BASES = ["consent", "legitimate_interest"] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export interface RecordConsentInput {
  personId: string;
  source: ConsentSource;
  basis: ConsentBasis;
  note?: string | null;
  ipPrefix?: string | null;
}

export async function recordConsent(
  db: Db,
  input: RecordConsentInput,
): Promise<string> {
  const id = nanoid();
  await db.insert(consents).values({
    id,
    personId: input.personId,
    source: input.source,
    basis: input.basis,
    note: input.note ?? null,
    ipPrefix: input.ipPrefix ?? null,
    consentedAt: Math.floor(Date.now() / 1000),
    revokedAt: null,
  });
  return id;
}

// Withdraw consent: stamp revokedAt on every still-active record for the
// contact. Returns the number of records revoked.
export async function revokeConsent(db: Db, personId: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const active = await db
    .select({ id: consents.id })
    .from(consents)
    .where(and(eq(consents.personId, personId), isNull(consents.revokedAt)));
  if (active.length === 0) return 0;
  await db
    .update(consents)
    .set({ revokedAt: now })
    .where(and(eq(consents.personId, personId), isNull(consents.revokedAt)));
  return active.length;
}

export interface ConsentStatus {
  hasActiveConsent: boolean;
  history: Array<typeof consents.$inferSelect>;
}

export async function getConsentStatus(
  db: Db,
  personId: string,
): Promise<ConsentStatus> {
  const history = await db
    .select()
    .from(consents)
    .where(eq(consents.personId, personId))
    .orderBy(desc(consents.consentedAt));
  const hasActiveConsent = history.some((r) => r.revokedAt === null);
  return { hasActiveConsent, history };
}
