import { mutation, query, v } from "./_generated/server.js";
export const executions: Record<string, number> = {};
function count(key: string) {
  executions[key] = (executions[key] ?? 0) + 1;
}
export const sidebar = query.query(async ({ ctx }) => {
  count("sidebar");
  return ctx.db.query("folders").withIndex("by_position").collect();
});
export const threads = query.input({ folder: v.string() }).query(async ({ ctx, args }) => {
  count(`threads:${args.folder}`);
  return ctx.db
    .query("threads")
    .withIndex("by_folder", (q) => q.eq("folder", args.folder))
    .collect();
});
export const seed = mutation.input({ count: v.number() }).mutation(async ({ ctx, args }) => {
  if ((await ctx.db.query("folders").collect()).length) return;
  await ctx.db.insert("folders", { key: "a", title: "Spike folder", position: 0 });
  await ctx.db.insert("folders", { key: "b", title: "Other folder", position: 1 });
  for (let i = 0; i < args.count; i++)
    await ctx.db.insert("threads", {
      key: `t${i}`,
      folder: i % 2 ? "b" : "a",
      title: `Synthetic thread ${i}`,
      status: "idle",
      revision: 0,
      position: i,
    });
});
export const update = mutation
  .input({ key: v.string(), revision: v.number(), folder: v.optional(v.string()) })
  .mutation(async ({ ctx, args }) => {
    const row = await ctx.db
      .query("threads")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (!row) throw new Error("Unknown synthetic thread");
    if (args.revision <= row.revision) return row.revision;
    await ctx.db.patch(row._id, {
      revision: args.revision,
      status: args.revision % 2 ? "running" : "idle",
      ...(args.folder === undefined ? {} : { folder: args.folder }),
    });
    return args.revision;
  });
