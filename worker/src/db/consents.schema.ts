import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// GDPR / LOPDGDD consent ledger. Append-only history of consent events
// per contact so we can prove, for any marketing send, that we had a
// lawful basis at the time. A contact "has active consent" if their most
// recent record has a null revokedAt and basis other than withdrawn.
export const consents = sqliteTable(
  "consents",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull(),
    // where the consent came from: manual | import | form | double_opt_in | api
    source: text("source").notNull(),
    // GDPR legal basis: consent | legitimate_interest
    basis: text("basis").notNull(),
    // free-form provenance: form URL, campaign name, ticket id, import batch
    note: text("note"),
    // truncated IP captured at opt-in time (GDPR: full IP is PII)
    ipPrefix: text("ip_prefix"),
    consentedAt: integer("consented_at").notNull(),
    // set when the contact withdraws consent; null = still active
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("consents_person_idx").on(table.personId, table.consentedAt),
  ],
);
