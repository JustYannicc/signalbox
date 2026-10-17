import { defineSchema, defineTable, v } from "lunorash/server";
export default defineSchema({
  folders: defineTable({ key: v.string(), title: v.string(), position: v.number() }).index(
    "by_position",
    ["position"],
  ),
  threads: defineTable({
    key: v.string(),
    folder: v.string(),
    title: v.string(),
    status: v.string(),
    revision: v.number(),
    position: v.number(),
  })
    .index("by_folder", ["folder", "position"])
    .index("by_key", ["key"]),
});
