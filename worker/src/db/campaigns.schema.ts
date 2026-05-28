import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// A one-shot broadcast to a tag segment. Backed by a single-step sequence
// (the `sequenceId`), so it reuses the suppression gate, tracking, and
// List-Unsubscribe machinery already wired into sequence delivery. The
// campaign row is the reporting anchor.
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    templateSlug: text("template_slug").notNull(),
    fromAddress: text("from_address").notNull(),
    // Tag segment the campaign was sent to. NULL would mean "all contacts"
    // but the create route currently always requires a tag.
    tag: text("tag"),
    // The single-step sequence created to drive delivery.
    sequenceId: text("sequence_id").notNull(),
    // Eligible recipients enrolled at send time (after suppression filter).
    totalRecipients: integer("total_recipients").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("campaigns_created_at_idx").on(table.createdAt)],
);
