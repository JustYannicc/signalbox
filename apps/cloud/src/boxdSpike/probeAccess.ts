export async function probeAuthorized(request: Request, token: string): Promise<boolean> {
  if (token.length < 32) return false;
  const supplied = request.headers.get("authorization");
  if (!supplied?.startsWith("Bearer ") || supplied.length > 512) return false;
  const encode = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(token)),
    crypto.subtle.digest("SHA-256", encode.encode(supplied.slice(7))),
  ]);
  const a = new Uint8Array(expected);
  const b = new Uint8Array(actual);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!;
  return different === 0;
}

export const probeReply = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
