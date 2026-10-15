import { describe, expect, it } from "vite-plus/test";

import type { Operation } from "./catalog.ts";
import { searchOperations } from "./search.ts";

const forAgents = (operation: Operation) => !operation.humanOnly && !operation.destructive;
const top = (query: string, limit = 3) =>
  searchOperations(query, { limit, include: forAgents }).map((operation) => operation.name);

describe("operation search", () => {
  // #436's first command set, as an agent would ask for it.
  it.each([
    ["create a folder", "folders.create"],
    ["list automations", "automations.list"],
    ["validate an automation", "automations.validate"],
    ["save an automation", "automations.save"],
    ["send a message to a thread", "threads.send"],
    ["change a setting", "settings.update"],
    ["list pools", "pools.list"],
    ["move a thread to a folder", "threads.move"],
    ["start a thread", "threads.create"],
  ])("finds %s", (query, expected) => {
    expect(top(query)).toContain(expected);
  });

  it("leaves out what the caller may not use", () => {
    expect(top("delete a folder", 20)).not.toContain("folders.delete");
    expect(top("respond to an approval", 20)).not.toContain("threads.respond");
  });

  it("finds nothing for nothing", () => {
    expect(top("")).toEqual([]);
  });
});
