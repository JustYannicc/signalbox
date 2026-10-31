import { expect, it } from "vite-plus/test";
import { findLossyHarnessCauses } from "./causeBoundaryGate.ts";

it.each([
  "const record = (value: unknown) => String(value)",
  "try { start() } catch (problem) { new Error(String(problem)) }",
  "Effect.mapError(() => new HarnessError({ operation: 'turn', message: 'Failed' }))",
  "Effect.tryPromise({ try: start, catch: reason => new HarnessError({ operation: 'turn', message: 'Failed' }) })",
  "Effect.catchCause(reason => new HarnessRequestFacetError('Failed'))",
  "try { start() } catch (cause) { throw new HarnessError({ operation: 'turn', message: 'Failed' }) }",
  "try { start() } catch { throw new HarnessRequestFacetError('Failed') }",
  "function fail(value) { return new Error(String(value)); }",
  "const record = (value: unknown) => `Failed: ${value}`",
  "const record = (value: unknown) => 'Failed: ' + value",
  "try { start() } catch (problem) { JSON.stringify(problem) }",
  "const record = (value: unknown) => Cause.squash(value)",
])("rejects throwable data loss: %s", (source) => {
  expect(findLossyHarnessCauses(source)).not.toEqual([]);
});

it.each([
  "throw new HarnessError({ operation: 'turn', message: 'No active turn' })",
  "Effect.mapError(cause => new HarnessError({ operation: 'turn', message: 'Failed', cause }))",
  "Effect.catchCause(cause => new HarnessRequestFacetError('Failed', { cause: serializeHarnessFailure(cause) }))",
  "try { start() } catch (cause) { throw new HarnessError({ operation: 'turn', message: 'Failed', cause }) }",
  "const text = (value: number) => String(value)",
  "const record = (value: unknown) => serializeHarnessFailure(value)",
  "const record = (value: unknown) => JSON.stringify(value)",
])("allows structured causes and unrelated values: %s", (source) => {
  expect(findLossyHarnessCauses(source)).toEqual([]);
});
