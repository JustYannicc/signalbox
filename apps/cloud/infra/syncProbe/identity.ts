// @effect-diagnostics globalDate:off -- Probe credentials expire against the plain Worker's wall clock.
const encoder = new TextEncoder();
const LEVELS = new Set(["top:test", "folder:test"]);
const TOKEN_TTL_SECONDS = 3600;

export interface ProbeIdentity extends Record<string, unknown> {
  readonly userId: "sync-probe-user";
  readonly levelId: string;
  readonly exp: number;
}

const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const decode = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const signingKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

export async function issueProbeToken(
  secret: string,
  levelId: string,
  now = Date.now(),
): Promise<string> {
  if (!LEVELS.has(levelId)) throw new Error("Unknown probe level.");
  const payload = encode(
    encoder.encode(
      JSON.stringify({
        userId: "sync-probe-user",
        levelId,
        exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS,
      }),
    ),
  );
  const message = `v1.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    encoder.encode(message),
  );
  return `${message}.${encode(new Uint8Array(signature))}`;
}

export async function resolveProbeIdentity(
  request: Request,
  secret: string,
): Promise<ProbeIdentity | null> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/u)?.[1];
  const token = bearer ?? new URL(request.url).searchParams.get("token") ?? undefined;
  if (secret.length < 32 || token === undefined) return null;

  const [version, payload, encodedSignature, extra] = token.split(".");
  if (
    version !== "v1" ||
    payload === undefined ||
    encodedSignature === undefined ||
    extra !== undefined
  )
    return null;

  try {
    const message = `${version}.${payload}`;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(secret),
        decode(encodedSignature),
        encoder.encode(message),
      ))
    )
      return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("userId" in parsed) ||
      parsed.userId !== "sync-probe-user" ||
      !("levelId" in parsed) ||
      typeof parsed.levelId !== "string" ||
      !LEVELS.has(parsed.levelId) ||
      !("exp" in parsed) ||
      typeof parsed.exp !== "number" ||
      parsed.exp <= Math.floor(Date.now() / 1000)
    )
      return null;
    return { userId: parsed.userId, levelId: parsed.levelId, exp: parsed.exp };
  } catch {
    return null;
  }
}

export const PROBE_LEVELS = [...LEVELS] as const;
