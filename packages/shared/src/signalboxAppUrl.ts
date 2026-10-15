/**
 * Signalbox Cloud's web app. Clients sign in here by default: desktop without a local server,
 * and mobile unless `EXPO_PUBLIC_SIGNALBOX_SERVER_URL` names another server. Shared links
 * (prompt links) open here too, not on upstream's hosted static app: that one is
 * `DEFAULT_HOSTED_APP_URL`, which also decides whether a page is a backend-less hosted client,
 * so it stays upstream's.
 */
export const SIGNALBOX_APP_URL = "https://app.signalbox.run";
