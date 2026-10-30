import type { HarnessProcessResumePreparedRelease } from "../../../../src/harness/HarnessProcessResume.ts";
import type { AssetFetcher } from "../../../../src/assets/ChunkedAsset.ts";
import { validateMachineProgramInventory } from "../../../../src/computer/MachineProgramInventory.ts";
import {
  ConfigurationSchema,
  decodeConfiguration,
  type AssetPinSchema,
} from "./configuration.schema.ts";
import { verifySeedConfiguration } from "./seedConfiguration.ts";
import { assert, sha256 } from "./common.ts";

export type AssetPin = typeof AssetPinSchema.Type;
type DecodedConfiguration = typeof ConfigurationSchema.Type;
export type Configuration = Omit<DecodedConfiguration, "expectedRelease" | "claude"> & {
  readonly expectedRelease: HarnessProcessResumePreparedRelease;
  readonly claude: Omit<DecodedConfiguration["claude"], "expected"> & {
    readonly expected: Readonly<Record<"baseline" | "hooks", HarnessProcessResumePreparedRelease>>;
  };
};
export async function readAsset(binding: AssetFetcher, pin: AssetPin) {
  const response = await binding.fetch(new Request(`https://assets.invalid/${pin.path}`));
  assert(response.ok, `Missing pinned asset ${pin.path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(
    bytes.length === pin.bytes && (await sha256(bytes)) === pin.sha256,
    `Changed asset ${pin.path}`,
  );
  return bytes;
}
export async function readConfiguration(binding: AssetFetcher, configHash: string) {
  const response = await binding.fetch(new Request("https://assets.invalid/qualifier/config.json"));
  assert(response.ok, "The frozen qualifier configuration is missing");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert((await sha256(bytes)) === configHash, "The qualifier configuration hash changed");
  const config = decodeConfiguration(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  validateMachineProgramInventory(config.machineInventory);
  await verifySeedConfiguration(config.seed);
  return config;
}
