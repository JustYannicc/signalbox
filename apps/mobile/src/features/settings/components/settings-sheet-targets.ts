export type SettingsSheetTarget =
  | "SettingsEnvironments"
  | "SettingsNotifications"
  | "SettingsThreads"
  | "SettingsAbout"
  | "SettingsArchive"
  | "SettingsAppearance"
  | "SettingsOrganization"
  | "SettingsProjectOverview"
  | "SettingsEnvironmentNewThreads"
  | "SettingsEnvironmentSourceControl"
  | "SettingsEnvironmentAgentBehavior"
  | "SettingsEnvironmentMaintenance"
  | "SettingsProviderAccounts"
  | "SettingsKeyboard"
  | "SettingsMicrophone"
  | "SettingsFollowUp"
  | "SettingsScheduledTasks"
  | "SettingsTimeZone"
  | "SettingsConnectedServices" // signalbox: automations
  | "SettingsSignIn" // signalbox: sign-in grants
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  | "SettingsUsage";

export type SettingsLegalDocumentTarget = "SettingsLegal";
