import { defineSchema, defineTable, v } from "lunorash/server";

export default defineSchema({
  folders: defineTable({
    __sync_domain_id: v.string(),
    parentId: v.union(v.string(), v.null()),
    parentIncarnation: v.number(),
    incarnation: v.number(),
    name: v.string(),
    position: v.number(),
    state: v.union(v.literal("active"), v.literal("deleted")),
  })
    .index("__sync_key", ["__sync_domain_id"])
    .index("byParent", ["parentId", "parentIncarnation", "position", "__sync_domain_id"]),
  grants: defineTable({
    folderId: v.union(v.string(), v.null()),
    incarnation: v.number(),
    personId: v.string(),
    role: v.union(v.literal("Admin"), v.literal("Member"), v.literal("Viewer")),
  })
    .index("__sync_key", ["folderId", "incarnation", "personId"])
    .index("byPerson", ["personId", "folderId", "incarnation"]),
  memberships: defineTable({
    personId: v.string(),
    incarnation: v.number(),
    sourceRevision: v.number(),
    roleSlugs: v.union(v.array(v.string()), v.null()),
  })
    .index("__sync_key", ["personId"])
    .index("byIncarnation", ["incarnation", "personId"]),
  organizationReferences: defineTable({
    organizationId: v.string(),
    incarnation: v.number(),
    target: v.object({
      home: v.object({
        owner: v.union(
          v.object({
            _tag: v.literal("person"),
            id: v.string(),
          }),
          v.object({
            _tag: v.literal("organization"),
            id: v.string(),
          }),
        ),
        level: v.union(
          v.object({
            _tag: v.literal("top"),
          }),
          v.object({
            _tag: v.literal("folder"),
            id: v.string(),
          }),
        ),
        legacySource: v.optional(v.string()),
      }),
      incarnation: v.number(),
    }),
    filedUnder: v.object({
      home: v.object({
        owner: v.union(
          v.object({
            _tag: v.literal("person"),
            id: v.string(),
          }),
          v.object({
            _tag: v.literal("organization"),
            id: v.string(),
          }),
        ),
        level: v.union(
          v.object({
            _tag: v.literal("top"),
          }),
          v.object({
            _tag: v.literal("folder"),
            id: v.string(),
          }),
        ),
        legacySource: v.optional(v.string()),
      }),
      incarnation: v.number(),
    }),
  })
    .index("__sync_key", ["organizationId"])
    .index("byIncarnation", ["incarnation", "organizationId"]),
  root: defineTable({
    key: v.literal("root"),
    topologyRevision: v.number(),
    authEpoch: v.number(),
  }).index("__sync_key", ["key"]),
  state: defineTable({
    key: v.literal("state"),
    revision: v.number(),
    storageState: v.union(v.literal("open"), v.literal("retired")),
    level: v.object({
      home: v.object({
        owner: v.union(
          v.object({
            _tag: v.literal("person"),
            id: v.string(),
          }),
          v.object({
            _tag: v.literal("organization"),
            id: v.string(),
          }),
        ),
        level: v.union(
          v.object({
            _tag: v.literal("top"),
          }),
          v.object({
            _tag: v.literal("folder"),
            id: v.string(),
          }),
        ),
        legacySource: v.optional(v.string()),
      }),
      incarnation: v.number(),
    }),
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
