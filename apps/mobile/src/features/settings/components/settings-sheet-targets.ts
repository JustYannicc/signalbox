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
  | "SettingsConnectedServices" // signalbox: automations
  | "SettingsSignIn" // signalbox: sign-in grants
  | "SettingsTrash" // signalbox: trash
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  | "SettingsUsage";

export type SettingsLegalDocumentTarget = "SettingsLegal";
