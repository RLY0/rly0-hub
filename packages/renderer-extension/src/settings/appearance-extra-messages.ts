export interface AppearanceExtraMessages {
  readonly themeTitle: string;
  readonly themeDescription: string;
  readonly themeLight: string;
  readonly themeDark: string;
  readonly themeSystem: string;
  readonly accentTitle: string;
  readonly accentDescription: string;
  readonly accentBlue: string;
  readonly accentPurple: string;
  readonly accentGreen: string;
  readonly accentOrange: string;
  readonly accentRose: string;
  readonly autostartTitle: string;
  readonly autostartDescription: string;
  readonly autostartUnsupported: string;
  readonly autostartPending: string;
  readonly autostartFailed: string;
  readonly refreshFrequencyTitle: string;
  readonly refreshFrequencyDescription: string;
  readonly refreshFrequency30s: string;
  readonly refreshFrequency1m: string;
  readonly refreshFrequency3m: string;
  readonly refreshFrequency5m: string;
  readonly quotaAlertTitle: string;
  readonly quotaAlertDescription: string;
  readonly quotaAlertThreshold: string;
  readonly quotaAlertThresholdDescription: string;
  readonly quotaAlertThresholdInvalid: string;
}

export const appearanceExtraEnglish: AppearanceExtraMessages = Object.freeze({
  themeTitle: "Theme",
  themeDescription: "Choose the interface color theme.",
  themeLight: "Light",
  themeDark: "Dark",
  themeSystem: "Follow system",
  accentTitle: "Accent color",
  accentDescription: "Applied to the settings interface.",
  accentBlue: "Blue",
  accentPurple: "Purple",
  accentGreen: "Green",
  accentOrange: "Orange",
  accentRose: "Rose",
  autostartTitle: "Launch on system startup",
  autostartDescription: "Start RLY/0 Hub automatically when you sign in to Windows.",
  autostartUnsupported: "Not supported on this system.",
  autostartPending: "Syncing…",
  autostartFailed: "Sync failed, try again",
  refreshFrequencyTitle: "Data refresh frequency",
  refreshFrequencyDescription: "How often quota data is refreshed.",
  refreshFrequency30s: "30 seconds",
  refreshFrequency1m: "1 minute",
  refreshFrequency3m: "3 minutes",
  refreshFrequency5m: "5 minutes",
  quotaAlertTitle: "Low-quota alert",
  quotaAlertDescription: "Notify automatically when remaining quota falls below the threshold.",
  quotaAlertThreshold: "Alert threshold",
  quotaAlertThresholdDescription: "1–90%.",
  quotaAlertThresholdInvalid: "Enter a whole number from 1 to 90.",
});

export const appearanceExtraChinese: AppearanceExtraMessages = Object.freeze({
  themeTitle: "主题",
  themeDescription: "选择界面配色主题。",
  themeLight: "浅色",
  themeDark: "深色",
  themeSystem: "跟随系统",
  accentTitle: "强调色",
  accentDescription: "应用于设置界面。",
  accentBlue: "蓝色",
  accentPurple: "紫色",
  accentGreen: "绿色",
  accentOrange: "橙色",
  accentRose: "玫红",
  autostartTitle: "开机自动启动",
  autostartDescription: "登录 Windows 时自动启动零号枢纽。",
  autostartUnsupported: "当前系统不支持。",
  autostartPending: "同步中…",
  autostartFailed: "同步失败，请重试",
  refreshFrequencyTitle: "数据刷新频率",
  refreshFrequencyDescription: "额度数据的刷新间隔。",
  refreshFrequency30s: "30 秒",
  refreshFrequency1m: "1 分钟",
  refreshFrequency3m: "3 分钟",
  refreshFrequency5m: "5 分钟",
  quotaAlertTitle: "低额度自动提醒",
  quotaAlertDescription: "剩余额度低于阈值时自动提醒。",
  quotaAlertThreshold: "提醒阈值",
  quotaAlertThresholdDescription: "1～90%。",
  quotaAlertThresholdInvalid: "请输入 1～90 之间的整数。",
});
