import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { PersonTimezone } from "@t3tools/contracts/personTimezone";

describe("person timezone", () => {
  const valid = Schema.is(PersonTimezone);
  it("accepts named zones, including UTC and non-hour offsets", () => {
    for (const zone of ["UTC", "Europe/Zurich", "Asia/Kathmandu", "Australia/Lord_Howe"])
      expect(valid(zone)).toBe(true);
  });
  it("rejects invalid zones and numeric offsets that cannot follow daylight saving", () => {
    for (const zone of ["", "No/Such_Zone", " Europe/Zurich ", "+01:00", "x".repeat(129)])
      expect(valid(zone)).toBe(false);
  });
});
