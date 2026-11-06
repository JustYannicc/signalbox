import { expect, it, vi } from "vite-plus/test";
import { ownComputerProgramCatalog } from "./ComputerProgramCatalogOwner.ts";
import { commandProgramCodes } from "./commandGatewayTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("shares an owned factory across aliases and releases it exactly once", async () => {
  const modules = { "main.js": "export default class {}" };
  let incomingOpen = true;
  let duplicates = 0;
  let disposals = 0;
  const source = Object.assign(
    () => {
      if (!incomingOpen) throw new Error("Borrowed factory expired");
      return modules;
    },
    {
      dup() {
        duplicates++;
        let open = true;
        return Object.assign(
          () => {
            if (!open) throw new Error("Owned factory closed");
            return modules;
          },
          {
            [Symbol.dispose]() {
              if (open) {
                open = false;
                disposals++;
              }
            },
          },
        );
      },
    },
  );
  const programs = commandProgramCodes();
  const catalog = ownComputerProgramCatalog({
    ...programs,
    bash: { ...programs.bash, modules: source },
  });
  const bash = catalog.programs.get("/bin/bash")!;
  const shell = catalog.programs.get("/bin/sh")!;
  incomingOpen = false;
  expect(bash.code.modules).toBe(shell.code.modules);
  if (typeof bash.code.modules !== "function") throw new Error("Factory was discarded");
  expect(await bash.code.modules()).toEqual(modules);
  expect(duplicates).toBe(1);
  catalog[Symbol.dispose]();
  catalog[Symbol.dispose]();
  expect(disposals).toBe(1);
  await expect(
    Promise.resolve().then(() => typeof bash.code.modules === "function" && bash.code.modules()),
  ).rejects.toThrow("Owned factory closed");
});

it("releases acquired factories if a later duplicate cannot be acquired", () => {
  const programs = commandProgramCodes();
  let released = 0;
  const first = Object.assign(() => ({}), {
    dup: () =>
      Object.assign(() => ({}), {
        [Symbol.dispose]() {
          released++;
        },
      }),
  });
  const second = Object.assign(() => ({}), {
    dup() {
      throw new Error("Cannot retain source");
    },
  });
  expect(() =>
    ownComputerProgramCatalog({
      ...programs,
      bash: { ...programs.bash, modules: first },
      ripgrep: { ...programs.ripgrep, modules: second },
    }),
  ).toThrow("Cannot retain source");
  expect(released).toBe(1);
});
