import { defineIdentity, v } from "lunorash/server";

export const identity = defineIdentity({
  userId: v.string(),
  levelId: v.string(),
  exp: v.number(),
});
