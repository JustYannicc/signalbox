# App distribution

How Signalbox's own desktop and mobile builds get signed and reach devices, and
which steps stay with the account owner. Every owner step runs through
`scripts/owner-setup/owner-setup.sh <section>`, which opens each page, names
every field, and moves downloaded keys into GitHub or EAS without printing them.
Agents do everything after that from the stored secrets.

## macOS signing identity

Without an Apple Developer ID, desktop builds sign with a self-signed
certificate. Squirrel.Mac installs an update only when it satisfies the running
app's designated requirement. Ad hoc signatures differ on every build, so they
reject every update; a fixed certificate gives the same requirement each time:

```text
identifier "com.justyannicc.signalbox" and certificate leaf = H"…"
```

- The identity lives in the GitHub secrets `MACOS_SELF_SIGNED_P12` (base64
  `.p12`) and `MACOS_SELF_SIGNED_P12_PASSWORD`.
  `scripts/release-identity/macos-self-signed.sh` created them, after signing
  two different binaries and checking that one satisfies the other's
  requirement. It refuses to replace them without `--rotate`.
- Rotating the certificate, or moving to a Developer ID, changes the
  requirement. Every install then installs the next build by hand once.
- Gatekeeper blocks the first install of a self-signed app. Open it once from
  System Settings → Privacy & Security → Open Anyway. Updates after that
  install silently.
- A Developer ID removes the Gatekeeper prompt. It needs the Apple Developer
  Program, and Apple lets only the Account Holder create the certificate. The
  release workflows already sign and notarize when `CSC_LINK` and the
  `APPLE_API_*` secrets are present.

## iOS

iOS ships through TestFlight internal testing, which needs the paid Apple
Developer Program but no App Review. The `apple` section enrolls, then stores:

| Value                                                   | Where           | Used for                                                                  |
| ------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | GitHub secrets  | App Store Connect API (Admin): bundle ids, signing, testers, notarization |
| `APNS_PRIVATE_KEY`, `APNS_KEY_ID`                       | GitHub secrets  | Push delivery, with `APPLE_TEAM_ID`                                       |
| `APPLE_TEAM_ID`                                         | GitHub variable | `appleTeamId` in `apps/mobile/app.config.ts`, APNs team                   |

It also has the owner create the App ID and the App Store Connect app record:
Apple's API can't create app records, and the record needs the bundle id first.

With the API key, EAS creates distribution certificates, provisioning profiles
and bundle ids (`EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID`,
`EXPO_APPLE_TEAM_ID`, `EXPO_APPLE_TEAM_TYPE`). It can't create push keys, which
is why the push key is an owner step. Bundle capabilities go through the App
Store Connect API's `bundleIdCapabilities`.

`appleTeamId` in `app.config.ts` and `ascAppId` in `apps/mobile/eas.json` still
carry the upstream project's Apple team and app until the owner steps are done.

## Android

Android installs a sideloaded APK and receives pushes through Firebase Cloud
Messaging (see [Android notifications](./android-notifications.md)). The
`android` section creates the Firebase project in the same Google Cloud project
as Google sign-in, stores `google-services.json` as the EAS file variable
`T3CODE_ANDROID_GOOGLE_SERVICES_FILE`, and stores the sender key as the GitHub
secret `FCM_SERVICE_ACCOUNT`.

## CI builds

EAS builds from GitHub Actions need `EXPO_TOKEN`, which the `expo` section
stores.
