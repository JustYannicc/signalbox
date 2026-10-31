export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });
export const MODEL_ORIGIN = "http://model.invalid";
export const HOME = "/workspace/.home/codex";
export const CODEX_HOME = `${HOME}/.codex`;
export const PROCESS_ID = "official-codex";
export const CREATION_ID = "cold-create";
export const RESUME_ID = "completed-turn-replacement";
export const C4 = "not covered: no isolate-to-tools-gateway grant binding exists yet";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function reference(id: string, bytes: Uint8Array) {
  return { id, bytes: bytes.byteLength, sha256: await sha256(bytes) };
}
export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export function toBase64(value: Uint8Array) {
  let result = "";
  for (let start = 0; start < value.length; start += 8192)
    result += String.fromCharCode(...value.subarray(start, start + 8192));
  return btoa(result);
}
export const jsonBytes = (value: unknown) =>
  encoder.encode(
    JSON.stringify(value, (_key, field) =>
      field instanceof Uint8Array
        ? { encoding: "base64", value: toBase64(field) }
        : field instanceof ArrayBuffer
          ? { encoding: "base64", value: toBase64(new Uint8Array(field)) }
          : typeof field === "bigint"
            ? { encoding: "bigint", value: field.toString() }
            : field,
    ),
  );
export const control = (epoch: number) => ({
  ownerId: "combined-qualifier",
  incarnationId: `controller-${epoch}`,
  epoch,
  controlKey: `combined-controller-${epoch}-`.repeat(2),
});
export const publisherKey = (generation: number) => `combined-publisher-${generation}-`.repeat(2);
export const requestPublisherKey = (generation: number) =>
  `combined-request-publisher-${generation}-`.repeat(2);
export const supervisor = {
  epoch: 1,
  claimId: "combined-owner",
  supervisorKey: "combined-supervisor-key-".repeat(2),
};
export const RUN_CONTROL_KEY = "combined-run-control-key-".repeat(2);

export function sameArtifact(
  left: { id: string; bytes: number; sha256: string },
  right: { id: string; bytes: number; sha256: string },
) {
  return left.id === right.id && left.bytes === right.bytes && left.sha256 === right.sha256;
}
export { serializeHarnessFailure as errorRecord } from "../../../../src/harness/Harness.ts";
