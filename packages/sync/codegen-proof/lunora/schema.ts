import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
  counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]),
});
