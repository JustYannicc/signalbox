/**
 * signalbox: the settings that make a provider instance run on an account
 * pool. Spread into each poolable provider's settings schema.
 */
import * as Schema from "effect/Schema";

const hidden = { providerSettingsForm: { hidden: true } } as const;

export const poolInstanceSettingsFields = {
  // Bumped when the pool's hub changes, so the instance is rebuilt against it.
  hubRevision: Schema.optionalKey(Schema.Number).pipe(Schema.annotateKey(hidden)),
  // The pool whose accounts this instance runs on; absent means the personal pool.
  poolId: Schema.optionalKey(Schema.String).pipe(Schema.annotateKey(hidden)),
};

/** For harnesses whose only other setup is their own: `hub` runs them on a pool. */
export const poolHarnessSettingsFields = {
  setupMode: Schema.optionalKey(Schema.Literals(["existing", "hub"])).pipe(
    Schema.annotateKey(hidden),
  ),
  ...poolInstanceSettingsFields,
};
