import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssistantAvatarConfigSchema,
  AVATAR_ACCESSORIES,
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_FACES,
  AVATAR_SHAPES,
  DEFAULT_ASSISTANT_AVATAR,
  generateAvatar,
  type AssistantAvatarConfig,
} from "./avatarConfig";

const codec = Schema.fromJsonString(AssistantAvatarConfigSchema);
const decode = (value: unknown) => Schema.decodeSync(codec)(JSON.stringify(value));

describe("generateAvatar", () => {
  it("returns the same avatar for the same seed", () => {
    expect(generateAvatar("Appa")).toEqual(generateAvatar("Appa"));
  });

  it("spreads seeds across every option", () => {
    const configs = Array.from({ length: 600 }, (_, i) => generateAvatar(`seed-${i}`));
    const seen = (field: keyof AssistantAvatarConfig) =>
      new Set(configs.map((config) => config[field]));
    expect(seen("shape")).toEqual(new Set(AVATAR_SHAPES));
    expect(seen("color")).toEqual(new Set(AVATAR_COLORS));
    expect(seen("face")).toEqual(new Set(AVATAR_FACES));
    expect(seen("eyes")).toEqual(new Set(AVATAR_EYES));
    expect(seen("accessory")).toEqual(new Set(AVATAR_ACCESSORIES));
  });

  it("round-trips through the persisted schema", () => {
    for (let i = 0; i < 50; i++) {
      const config = generateAvatar(String(i));
      expect(decode(config)).toEqual(config);
    }
  });
});

describe("AssistantAvatarConfigSchema", () => {
  it("keeps what it recognises from a first-version config and defaults the rest", () => {
    const v1 = { shape: "blob", color: "mint", eyes: "dot", mouth: "cat", accessory: "sprout" };
    expect(decode({ ...v1, blush: true })).toEqual({
      ...DEFAULT_ASSISTANT_AVATAR,
      accessory: "sprout",
    });
  });

  it("falls back to the default for missing fields or a non-object", () => {
    expect(decode({})).toEqual(DEFAULT_ASSISTANT_AVATAR);
    expect(decode("garbage")).toEqual(DEFAULT_ASSISTANT_AVATAR);
    expect(decode(null)).toEqual(DEFAULT_ASSISTANT_AVATAR);
  });
});
