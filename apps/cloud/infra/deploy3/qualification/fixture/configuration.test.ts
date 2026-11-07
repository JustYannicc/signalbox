import { expect, it } from "vite-plus/test";
import { machineInventoryFixture } from "../../../../src/computer/machineInventoryTesting.ts";
import { sha256 } from "./common.ts";
import { readMachineInventory } from "./configuration.ts";

const inventory = machineInventoryFixture([{ path: "/bin/rg", mode: 0o755, uid: 0, gid: 0 }]);
const bytes = new TextEncoder().encode(JSON.stringify(inventory));
const served = (body: Uint8Array<ArrayBuffer>) => ({ fetch: async () => new Response(body) });
const pin = async () => ({
  path: "qualifier/machine-inventory/one.json",
  bytes: bytes.length,
  sha256: await sha256(bytes),
});

it("reads the machine inventory from its pinned asset", async () => {
  expect(await readMachineInventory(served(bytes), await pin())).toEqual(inventory);
});

it("refuses an inventory asset that differs from its pin", async () => {
  const changed = bytes.slice();
  changed[changed.length - 2] = changed.at(-2)! ^ 1;
  await expect(readMachineInventory(served(changed), await pin())).rejects.toThrow("Changed asset");
});
