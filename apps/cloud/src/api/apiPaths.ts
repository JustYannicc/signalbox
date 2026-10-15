import { API_VERSION } from "@signalbox/api/catalog";

/** Everything under this goes to the public API (`apiRoutes.ts`). */
export const API_PREFIX = `/api/${API_VERSION}/`;

export const isApiPath = (pathname: string) => pathname.startsWith(API_PREFIX);
