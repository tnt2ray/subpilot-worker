import type { RuleSetConfig } from "./rule-set-types";

export type Target = "surge" | "clash" | "sing-box";
export type ClientId = "surge" | "clash" | "singbox";
export type SourceFetchUserAgent = string;
export type NotificationChannel = "off" | "telegram";
export type SurgeIpv6VifMode = "off" | "auto" | "always";
export const CHAIN_EXIT_PROXY_NAME = "Chain Exit";
export const STATIC_EXIT_GROUP_NAME = "Static";

export interface SourceConfig {
  id: string;
  name: string;
  url: string;
  fetchUserAgent: SourceFetchUserAgent;
  enabled: boolean;
}

export interface SurgeConfig {
  skipProxy: string[];
  dnsServer: string[];
  alwaysRealIp: string[];
  managedConfigIntervalSeconds: number;
  internetTestUrl: string;
  proxyTestUrl: string;
  showErrorPageForReject: boolean;
  ipv6: boolean;
  ipv6Vif: SurgeIpv6VifMode;
  allowWifiAccess: boolean;
  tunExcludedRoutes: string[];
  encryptedDnsServer: string[];
  wifiAssist: boolean;
  excludeSimpleHostnames: boolean;
  encryptedDnsFollowOutboundMode: boolean;
  tailscaleNodes: SurgeTailscaleNodeConfig[];
  hosts: string[];
  urlRewrite: string[];
  mapLocal: string[];
  scripts: string[];
  mitm: SurgeMitmConfig;
  rules: string[];
}

export interface SurgeTailscaleNodeConfig {
  name: string;
  sectionName: string;
  authKey: string;
  interactiveLogin?: boolean;
  autoAddMagicDnsRule?: boolean;
  controlUrl: string;
  hostname: string;
  derpOnly: boolean;
  exitNode: string;
  idleKeepalive: number;
  preferIpv6: boolean;
  dnsServer: string[];
  mtu: number;
  underlyingProxy: string;
  testUrl: string;
  testTimeout: number;
  enabled: boolean;
}

export interface SurgeMitmConfig {
  skipServerCertVerify: boolean;
  h2: boolean;
  hostname: string[];
  caPassphrase: string;
  caP12: string;
}

export interface ClashConfig {
  port: number;
  socksPort: number;
  mixedPort: number;
  allowLan: boolean;
  mode: string;
  logLevel: string;
  ipv6: boolean;
  unifiedDelay: boolean;
  tcpConcurrent: boolean;
  externalController: string;
  tun: ClashTunConfig;
  dnsEnabled: boolean;
  dnsListen: string;
  dnsListenRoutingMark: number;
  dnsFallbackLazyQuery: boolean;
  dnsIpv6: boolean;
  dnsEnhancedMode: string;
  dnsFakeIpRange: string;
  defaultNameservers: string[];
  nameservers: string[];
  fallbackNameservers: string[];
  fallbackFilterGeoip: boolean;
  fallbackFilterIpcidr: string[];
  fakeIpFilter: string[];
  tailscaleNodes: ClashTailscaleNodeConfig[];
  ruleProviders: string;
  rules: string[];
}

/** Mihomo-native fields; omitted options retain the core's defaults. */
export type ClashTailscaleNodeConfig = Record<string, ProxyParamValue> & { name: string; type: "tailscale" };

export interface ClashTunConfig {
  enable: boolean;
  stack: string;
  autoRoute: boolean;
  autoDetectInterface: boolean;
  skipProxy: string[];
}

export interface StaticProxyNodeConfig {
  id: string;
  config: string;
  chainFilter: string[];
  enabled: boolean;
  chainExit: boolean;
  includeInGroups: boolean;
}

export interface ActionsCompilationSettings {
  enabled: boolean;
  repository: string;
  ref: string;
}

export interface RenderConfig {
  document?: AppConfig;
  renderTarget?: Target;
  settings: {
    managedBaseUrl: string;
    userAgentSurge: string;
    userAgentClash: string;
    excludeKeywords: string[];
    geoipRenameEnabled: boolean;
    featureTagRules: string[];
    updateCheckEnabled: boolean;
    displayTimeZone: string;
    actionsCompilation?: ActionsCompilationSettings;
    notificationChannel: NotificationChannel;
    notificationTelegramChatId: string;
    notificationTelegramBotToken: string;
    notificationTelegramWebhookSecret: string;
  };
  groups: Record<string, string>;
  disabledGroups: string[];
  sources: SourceConfig[];
  proxyNodes: StaticProxyNodeConfig[];
  ruleSets: RuleSetConfig;
  surge: SurgeConfig;
  clash: ClashConfig;
  updatedAt?: string | undefined;
}

export type ProxyParamValue =
  | string
  | number
  | boolean
  | null
  | ProxyParamValue[]
  | { [key: string]: ProxyParamValue };

export type HostEntryValue = string | string[];

export interface HostEntry {
  host: string;
  value: HostEntryValue;
}

export interface ProxyNode {
  singbox?: Record<string, ProxyParamValue>;
  name: string;
  originalName?: string | undefined;
  /** Original source-scoped names retained when identical nodes are merged. */
  referenceAliases?: Array<{ scope: string; name: string }> | undefined;
  /** URI transport before target rendering, used to reject unsupported conversions. */
  uriTransport?: string | undefined;
  type: string;
  server: string;
  port?: number | undefined;
  password?: string | undefined;
  uuid?: string | undefined;
  cipher?: string | undefined;
  params: Record<string, ProxyParamValue>;
  raw?: Record<string, ProxyParamValue> | undefined;
  surgeDetail?: string | undefined;
  paramsNormalized?: boolean | undefined;
  sourceId?: string | undefined;
  sourceName?: string | undefined;
  featureTags?: string[] | undefined;
  matchLabels?: string[] | undefined;
  manual?: boolean | undefined;
  chainExit?: boolean | undefined;
  /** Transient marker for nodes created by buildChainNodes, never stored in configuration. */
  generatedChain?: boolean | undefined;
  chainFilter?: string[] | undefined;
  includeInGroups?: boolean | undefined;
}

export interface GenerationResult {
  target: Target;
  content: string;
  contentType: string;
  proxyCount: number;
  fetchedSources: number;
  warnings: string[];
  diagnostics: ConfigDiagnostic[];
  canDownload: boolean;
  /** Transient rule-cache preparation; clients should retain their current configuration. */
  retryAfterSeconds?: number;
}

/** Persisted configuration. Format-specific fields never inherit from another client. */
export interface AppConfig {
  version: 3;
  settings: RenderConfig["settings"];
  sources: SourceConfig[];
  proxyNodes: StaticProxyNodeConfig[];
  clients: {
    surge: SurgeConfig & ClientRuleSettings;
    clash: ClashConfig & ClientRuleSettings;
    singbox: SingboxConfig & ClientRuleSettings;
  };
  updatedAt?: string | undefined;
}

export interface ClientRuleSettings {
  groups: Record<string, string>;
  disabledGroups: string[];
  ruleSets: RuleSetConfig;
}

export interface ConfigDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  target: Target;
  path: string;
  message: string;
}

export interface SingboxConfig {
  coreVersion: "1.15.0-alpha.8";
  log: Record<string, ProxyParamValue>;
  dns: Record<string, ProxyParamValue>;
  inbounds: Record<string, ProxyParamValue>[];
  endpoints?: Record<string, ProxyParamValue>[];
  outbounds?: Record<string, ProxyParamValue>[];
  ntp?: Record<string, ProxyParamValue>;
  certificate?: Record<string, ProxyParamValue>;
  certificate_providers?: Record<string, ProxyParamValue>[];
  http_clients?: Record<string, ProxyParamValue>[];
  network_namespaces?: Record<string, ProxyParamValue>[];
  services?: Record<string, ProxyParamValue>[];
  route: Record<string, ProxyParamValue>;
  experimental: Record<string, ProxyParamValue>;
}
