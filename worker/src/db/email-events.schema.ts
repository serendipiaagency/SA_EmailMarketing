import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// Append-only log of recipient-side interactions with a sent email:
// open (pixel beacon hit), click (link redirect hit). One row per event,
// retained for analytics and downstream stats aggregation.
//
// Each row is intentionally cheap (no FK constraints) so writes from the
// public tracking endpoints stay fast. `sentEmailId` is a logical
// reference to sent_emails.id; rows for emails that get deleted are
// orphaned (still useful as aggregate counters).
export const emailEvents = sqliteTable(
  "email_events",
  {
    id: text("id").primaryKey(),
    sentEmailId: text("sent_email_id").notNull(),
    // canonical lowercase recipient — denormalized so we can answer
    // "who opened our last campaign?" without joining sent_emails.
    recipient: text("recipient").notNull(),
    // "opened" | "clicked"
    kind: text("kind").notNull(),
    // populated only for kind = "clicked"; the URL the user followed.
    url: text("url"),
    // user-agent string, capped to a reasonable length on insert.
    userAgent: text("user_agent"),
    // IPv4 truncated to /24 ("198.51.100.0") or IPv6 to /48
    // ("2001:db8:abcd::"). Storing the full address would be PII under
    // GDPR/LOPDGDD — truncation preserves geo / abuse signal without
    // identifying the recipient device.
    ipPrefix: text("ip_prefix"),
    eventAt: integer("event_at").notNull(),
  },
  (table) => [
    index("email_events_sent_at_idx").on(table.sentEmailId, table.eventAt),
    index("email_events_kind_at_idx").on(table.kind, table.eventAt),
    index("email_events_recipient_at_idx").on(table.recipient, table.eventAt),
  ],
);
