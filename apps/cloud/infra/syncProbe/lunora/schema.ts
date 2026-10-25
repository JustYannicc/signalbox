import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
  counters: defineTable({
    key: v.string(),
    value: v.number(),
  }).index("__sync_key", ["key"]),
  syncReceipts: defineTable({
    scope: v.string(),
    operationKey: v.string(),
    payload: v.string(),
    value: v.string(),
    fences: v.array(
      v.object({
        scope: v.string(),
        epoch: v.number(),
      }),
    ),
    pending: v.boolean(),
  })
    .index("__sync_key", ["scope", "operationKey"])
    .index("pending", ["pending"]),
});
