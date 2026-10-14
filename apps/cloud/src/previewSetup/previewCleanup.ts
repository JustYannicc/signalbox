// @effect-diagnostics globalConsole:off -- report internal cleanup failures to Worker logs.
import {
  runPreviewCleanup,
  type PreviewCleanupBindings,
  type PreviewCleanupCommand,
} from "./PreviewCleanupService.ts";

export const PREVIEW_CLEANUP_PATH = "/api/internal/preview-cleanup";

export interface PreviewCleanupEnv extends PreviewCleanupBindings {
  readonly PREVIEW_CLEANUP_TOKEN?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const previewNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

const previewPoolIds = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)
    ? value
    : null;

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
};

const authorized = (request: Request, expected: string) => {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeEqual(token, expected);
};

const decodeCommand = (body: unknown): PreviewCleanupCommand | { readonly error: string } => {
  if (!isRecord(body) || typeof body.action !== "string") {
    return { error: "Invalid cleanup request." };
  }
  if (body.action === "list" || body.action === "clear-legacy-packs") {
    return { action: body.action };
  }
  if (body.action === "activate" || body.action === "delete") {
    const pullRequestNumber = previewNumber(body.pullRequestNumber);
    return pullRequestNumber === null
      ? { error: "Invalid pull request number." }
      : { action: body.action, pullRequestNumber };
  }
  if (body.action === "delete-links") {
    const pullRequestNumber = previewNumber(body.pullRequestNumber);
    const poolObjectIds = previewPoolIds(body.poolObjectIds);
    return pullRequestNumber === null || poolObjectIds === null || poolObjectIds.length === 0
      ? { error: "Invalid pool link cleanup request." }
      : { action: "delete-links", pullRequestNumber, poolObjectIds };
  }
  return { error: "Unknown cleanup action." };
};

/** Authenticated control surface used only by the close and sweep workflows. */
export const handlePreviewCleanup = async (
  request: Request,
  env: PreviewCleanupEnv,
): Promise<Response> => {
  const expected = env.PREVIEW_CLEANUP_TOKEN;
  if (!expected) return new Response("Not found.", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
  if (!authorized(request, expected)) return new Response("Unauthorized.", { status: 401 });

  try {
    const decoded = decodeCommand(await request.json());
    if ("error" in decoded) return Response.json({ error: decoded.error }, { status: 400 });
    return Response.json(await runPreviewCleanup(decoded, env));
  } catch (cause) {
    console.error("Preview cleanup failed.", cause);
    return Response.json({ error: "Preview cleanup failed." }, { status: 500 });
  }
};
