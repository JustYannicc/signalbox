// @effect-diagnostics cryptoRandomUUID:off - fake secrets are generated per run, so no test ever holds a real one.
import { describe, expect, it } from "vite-plus/test";

import {
  fillPlaceholders,
  makeSecretLookup,
  placeholderNames,
  secretsIn,
} from "./SecretPlaceholders.ts";

const fake = (label: string) => `${label}-${crypto.randomUUID()}`;

describe("SecretPlaceholders", () => {
  it("fills known placeholders, spaces and all, and leaves unknown ones as written", () => {
    const value = fake("sk-test");
    const filled = fillPlaceholders(
      'curl -H "Authorization: Bearer {{ secret:KEY }}" -d {{secret:OTHER}} secret:KEY',
      new Map([["KEY", value]]),
    );

    expect(filled.text).toBe(
      `curl -H "Authorization: Bearer ${value}" -d {{secret:OTHER}} secret:KEY`,
    );
    expect([...filled.used]).toEqual(["KEY"]);
    expect([...filled.unknown]).toEqual(["OTHER"]);
  });

  it("names a secret sent by placeholder or by any form of its value", () => {
    const key = fake("sk-test");
    const token = fake("ghp");
    const lookup = makeSecretLookup([
      { name: "KEY", value: key },
      { name: "TOKEN", value: token },
    ]);

    expect([...placeholderNames("x {{secret:KEY}} y")]).toEqual(["KEY"]);
    expect([...secretsIn(`Basic ${btoa(`me:${key}`)}`, lookup.scrubber)]).toEqual(["KEY"]);
    expect(
      [
        ...secretsIn(`{"t":"${encodeURIComponent(token)}","k":"{{secret:KEY}}"}`, lookup.scrubber),
      ].toSorted(),
    ).toEqual(["KEY", "TOKEN"]);
    expect(secretsIn("nothing here", lookup.scrubber).size).toBe(0);
  });
});
