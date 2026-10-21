export interface ReplayInputRouteDescriptor {
  readonly routeId: string;
  readonly userContentSha256s?: readonly string[];
  readonly firstUserContentSha256?: string;
}

export type AdjacentRecordedUserRoute =
  | {
      readonly status: "matched";
      readonly routeId: string;
      readonly reason: "adjacent-recorded-user-content";
    }
  | {
      readonly status: "ambiguous";
      readonly candidateCount: number;
      readonly reason: "adjacent-recorded-user-content";
    };

interface TextCandidate {
  readonly exact: string;
  readonly separator: string | null;
}

export async function contentDigest(content: string): Promise<string> {
  const normalized = [{ type: "text", text: content }];
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function choose(candidates: readonly string[]): AdjacentRecordedUserRoute | null {
  const unique = [...new Set(candidates)];
  return unique.length === 1
    ? { status: "matched", routeId: unique[0]!, reason: "adjacent-recorded-user-content" }
    : unique.length > 1
      ? {
          status: "ambiguous",
          candidateCount: unique.length,
          reason: "adjacent-recorded-user-content",
        }
      : null;
}

function hasOnlyTextFields(
  value: unknown,
): value is { readonly type: "text"; readonly text: string } {
  if (!value || typeof value !== "object") return false;
  const block = value as { readonly type?: unknown; readonly text?: unknown };
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    Object.keys(value).every((key) => key === "type" || key === "text")
  );
}

/**
 * Matches merged text blocks to one route's original ordered inputs. The CLI
 * adds one LF between adjacent user messages, so every nonfinal block must
 * end in exactly that separator and the final block must match exactly.
 */
export async function selectAdjacentRecordedUserRoute(
  content: unknown,
  routes: readonly ReplayInputRouteDescriptor[],
  lookupRecordedInputs: (
    routeId: string,
  ) => Promise<readonly string[] | null> | readonly string[] | null,
): Promise<AdjacentRecordedUserRoute | null> {
  if (
    !Array.isArray(content) ||
    content.length < 2 ||
    typeof lookupRecordedInputs !== "function" ||
    !content.every(hasOnlyTextFields)
  )
    return null;

  const candidates: TextCandidate[] = await Promise.all(
    content.map(async (block, index) => ({
      exact: await contentDigest(block.text),
      separator:
        index < content.length - 1 && block.text.endsWith("\n")
          ? await contentDigest(block.text.slice(0, -1))
          : null,
    })),
  );

  const possibleRoutes = routes.filter((route) => {
    const digests =
      route.userContentSha256s ??
      (route.firstUserContentSha256 ? [route.firstUserContentSha256] : []);
    return candidates.every(
      ({ exact, separator }) =>
        digests.includes(exact) || (separator !== null && digests.includes(separator)),
    );
  });

  const matching: string[] = [];
  for (const route of possibleRoutes) {
    const inputs = await lookupRecordedInputs(route.routeId);
    if (!Array.isArray(inputs) || inputs.length < content.length) continue;

    for (let start = 0; start <= inputs.length - content.length; start += 1) {
      const matches = candidates.every(({ exact, separator }, offset) => {
        const recorded = inputs[start + offset];
        return offset < content.length - 1
          ? separator !== null && recorded === separator
          : recorded === exact;
      });
      if (matches) {
        matching.push(route.routeId);
        break;
      }
    }
  }

  return choose(matching);
}
