import type { CapacitorConfig } from "@capacitor/cli";

/** UNVERIFIED — never built: no JDK / Android SDK existed in the build
 *  sandbox, so no APK was produced and this config was never run.
 *  Starting point for a later APK build on a PC with Android Studio.
 *  Keystore safety: create ONE keystore, back it up somewhere safe, never
 *  commit it. A lost keystore means updates cannot install over the old app. */
const config: CapacitorConfig = {
  appId: "com.chichawatni.carcalc",
  appName: "Car Calculator",
  webDir: "dist",
  server: { androidScheme: "https" },
};

export default config;
