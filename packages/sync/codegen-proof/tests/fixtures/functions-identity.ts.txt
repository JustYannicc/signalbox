import { defineIdentity, v } from "lunorash/server";

export const identity = defineIdentity({ userId: v.string() });
