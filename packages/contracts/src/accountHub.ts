/**
 * The account hub is the CLIProxyAPI instance Signalbox runs itself. It
 * reports limits as an ordinary usage limit source with this fixed id, so
 * clients can tell it apart from a hub the user connected by URL.
 */
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

export const ACCOUNT_HUB_SOURCE_ID = UsageLimitSourceId.make("signalbox-account-hub");
