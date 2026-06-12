import { eq, and, sql, desc } from "drizzle-orm";
import { peopleTags } from "../db/people-tags.schema";
import type { Variables } from "../variables";

type Db = Variables["db"];

export const MAX_TAG_LENGTH = 64;

// Normalize a tag: trim + lowercase. Returns null if empty or too long
// (callers should reject null with a 400).
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t || t.length > MAX_TAG_LENGTH) return null;
  return t;
}

export async function addTag(
  db: Db,
  personId: string,
  rawTag: string,
): Promise<{ ok: true; tag: string } | { ok: false }> {
  const tag = normalizeTag(rawTag);
  if (!tag) return { ok: false };
  await db
    .insert(peopleTags)
    .values({ personId, tag, createdAt: Math.floor(Date.now() / 1000) })
    .onConflictDoNothing();
  return { ok: true, tag };
}

export async function removeTag(
  db: Db,
  personId: string,
  rawTag: string,
): Promise<void> {
  const tag = normalizeTag(rawTag);
  if (!tag) return;
  await db
    .delete(peopleTags)
    .where(and(eq(peopleTags.personId, personId), eq(peopleTags.tag, tag)));
}

export async function getTagsForPerson(
  db: Db,
  personId: string,
): Promise<string[]> {
  const rows = await db
    .select({ tag: peopleTags.tag })
    .from(peopleTags)
    .where(eq(peopleTags.personId, personId))
    .orderBy(peopleTags.tag);
  return rows.map((r) => r.tag);
}

export interface TagCount {
  tag: string;
  count: number;
}

// All distinct tags with how many contacts carry each — powers the
// segment builder UI.
export async function listAllTags(db: Db): Promise<TagCount[]> {
  const rows = await db
    .select({
      tag: peopleTags.tag,
      count: sql<number>`COUNT(*)`,
    })
    .from(peopleTags)
    .groupBy(peopleTags.tag)
    .orderBy(desc(sql`COUNT(*)`), peopleTags.tag);
  return rows.map((r) => ({ tag: r.tag, count: r.count }));
}

export async function personIdsByTag(
  db: Db,
  rawTag: string,
): Promise<string[]> {
  const tag = normalizeTag(rawTag);
  if (!tag) return [];
  const rows = await db
    .select({ personId: peopleTags.personId })
    .from(peopleTags)
    .where(eq(peopleTags.tag, tag));
  return rows.map((r) => r.personId);
}
