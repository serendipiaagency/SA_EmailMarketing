import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Active suppression list — one row per address that must NOT receive
// further mail. Compliance + deliverability gate. Inserts are upserts on
// `email`: a later, more severe reason (e.g. complaint) overrides an
// earlier one (e.g. unsubscribe) without losing the original createdAt.
export const suppressions = sqliteTable(
  "suppressions",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    // hard_bounce | soft_bounce_repeated | complaint | unsubscribe | manual | invalid
    reason: text("reason").notNull(),
    // free-form provenance: "webhook:cf", "webhook:resend", "user:<id>",
    // "import:<batch>", "public-unsubscribe"
    source: text("source"),
    // optional FK-by-convention to sent_emails.id when triggered by a
    // delivery event
    sentEmailId: text("sent_email_id"),
    // JSON payload of the originating event (webhook body, csv row, etc.)
    metadata: text("metadata"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("suppressions_reason_idx").on(table.reason),
    index("suppressions_created_at_idx").on(table.createdAt),
  ],
);
