import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import type { DriveRef, RecipeHash } from "../Computer.ts";
import { SqliteBoxdReservations } from "../adapters/SqliteBoxdReservations.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";

const input = {
  operationId: "operation-one",
  drive: "drive-one" as DriveRef,
  recipeHash: "recipe-one" as RecipeHash,
  base: Option.none(),
  expiresAt: 1_900_000_000_000,
};

describe("SqliteBoxdReservations", () => {
  it("reopens the exact reservation and allows only one create dispatch", async () => {
    const fixture = createTestFilesystem();
    try {
      const first = new SqliteBoxdReservations(fixture.storage, () => "reserved-one");
      const reservation = await first.reserve(input);
      expect(reservation).toMatchObject({
        name: "computer-reserved-one",
        generation: 1,
        createStarted: false,
      });
      expect(await first.startCreate(reservation)).toBe(true);
      const reopened = new SqliteBoxdReservations(fixture.storage, () => {
        throw new Error("must reuse");
      });
      expect(await reopened.reserve(input)).toEqual({ ...reservation, createStarted: true });
      expect(await reopened.startCreate(reservation)).toBe(false);
      await reopened.recordMachineId(reservation, "provider-one");
      expect((await first.reserve(input)).machineId).toBe("provider-one");
      await expect(first.recordMachineId(reservation, "other-provider")).rejects.toThrow(
        "identity changed",
      );
    } finally {
      fixture.close();
    }
  });

  it("rejects changed inputs and retains generation across released operations", async () => {
    const fixture = createTestFilesystem();
    try {
      let next = 0;
      const reservations = new SqliteBoxdReservations(fixture.storage, () => `reserved-${++next}`);
      const reservation = await reservations.reserve(input);
      await expect(
        reservations.reserve({ ...input, expiresAt: input.expiresAt + 1 }),
      ).rejects.toThrow("inputs changed");
      await reservations.release(reservation);
      await reservations.release(reservation);
      await expect(reservations.reserve(input)).rejects.toThrow("already released");
      await expect(reservations.startCreate(reservation)).rejects.toThrow("already released");
      const second = await reservations.reserve({ ...input, operationId: "operation-two" });
      expect(second.generation).toBe(2);
      await expect(reservations.release({ ...second, id: reservation.id })).rejects.toThrow(
        "ownership changed",
      );
    } finally {
      fixture.close();
    }
  });
});
