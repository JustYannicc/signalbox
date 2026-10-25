import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { secretForms } from "@signalbox/runner-protocol/SecretScrubber";
import { layerCrypto } from "../../src/platform.ts";

let values: ReturnType<typeof createValues> | undefined;
let previousValuePattern: RegExp | undefined;

// Lazy creation keeps values out of staged source and randomness inside request handling.
function fixtureValues() {
  return (values ??= createValues());
}

function createValues() {
  const ids = Effect.runSync(
    Crypto.Crypto.use((crypto) => Effect.all([crypto.randomUUIDv4(), crypto.randomUUIDv4()])).pipe(
      Effect.provide(layerCrypto),
    ),
  );
  return valuesFor(ids[0].slice(0, 8), ids[1]);
}

function valuesFor(namedId: string, vaultId: string) {
  return { named: `api-${namedId}-東京`, vault: `proof-vault-${vaultId}-秘密` };
}

/** Retained files must still fail verification after an isolate creates a new pair. */
export function containsGeneratedFixtureValue(text: string) {
  previousValuePattern ??= createPreviousValuePattern();
  return previousValuePattern.test(text);
}

function createPreviousValuePattern() {
  // Each encoding preserves fixed positions. Varying every hex digit identifies its variable positions.
  const variants = [..."0123456789abcdef"].map((digit) => {
    const uuid = [8, 4, 4, 4, 12].map((size) => digit.repeat(size)).join("-");
    const sample = valuesFor(digit.repeat(8), uuid);
    return [secretForms(sample.named), secretForms(sample.vault)];
  });
  const patterns = variants[0]!.flatMap((group, groupIndex) =>
    group.map((form, formIndex) => {
      if (variants.some((variant) => variant[groupIndex]?.[formIndex]?.length !== form.length))
        throw new Error("Generated fixture forms changed shape");
      return [...form]
        .map((char, index) =>
          variants.every((variant) => variant[groupIndex]![formIndex]![index] === char)
            ? char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            : "[A-Za-z0-9+/_=-]",
        )
        .join("");
    }),
  );
  return new RegExp(patterns.join("|"), "u");
}

export const STANDARD_PROOF_NAMED_SECRET = {
  name: "API_TOKEN",
  get value() {
    return fixtureValues().named;
  },
};
export const STANDARD_PROOF_VAULT_SECRET = {
  name: "VAULT_TOKEN",
  get value() {
    return fixtureValues().vault;
  },
};

export function standardProofFilledWrite() {
  return `official write: ${STANDARD_PROOF_NAMED_SECRET.value} ${STANDARD_PROOF_VAULT_SECRET.value}\n`;
}
