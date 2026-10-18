const { withAndroidManifest } = require("expo/config-plugins");

const SCHEME_METADATA = "com.signalbox.capture.SCHEME";

module.exports = function withCaptureTile(config) {
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;
  if (!scheme) throw new Error("Capture requires the app's deep-link scheme.");
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error("Capture requires an Android application element.");
    const metadata = application["meta-data"] ?? [];
    application["meta-data"] = [
      ...metadata.filter((entry) => entry.$["android:name"] !== SCHEME_METADATA),
      { $: { "android:name": SCHEME_METADATA, "android:value": scheme } },
    ];
    return nextConfig;
  });
};
