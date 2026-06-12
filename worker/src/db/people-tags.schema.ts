import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

// Free-form labels on contacts, the foundation for segmentation /
// campaigns. One row per (person, tag). Tags are normalized to lowercase
// on write so "Customer" and "customer" don't fork.
export const peopleTags = sqliteTable(
  "people_tags",
  {
    personId: text("person_id").notNull(),
    tag: text("tag").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.personId, table.tag] }),
    index("people_tags_tag_idx").on(table.tag),
  ],
);
