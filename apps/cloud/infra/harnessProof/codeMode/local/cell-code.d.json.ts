import type { prepareCodeModeHost } from "../prepare.ts";

type Code = Awaited<ReturnType<typeof prepareCodeModeHost>>["code"];
export declare const mainModule: Code["mainModule"];
export declare const modules: Code["modules"];
