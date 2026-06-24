export type Target = "surge" | "clash" | "stash";
export type SourceFetchUserAgent = "surge" | "clash";
export type NotificationChannel = "off" | "telegram";
export type SurgeIpv6VifMode = "off" | "auto" | "always";
export const CHAIN_EXIT_PROXY_NAME = "Chain Exit";
export const STATIC_EXIT_GROUP_NAME = "Static";
export const CHAIN_EXIT_PROTOCOLS = [
  "http",
  "https",
  "socks5",
  "socks5-tls",
  "ss",
  "snell",
  "trojan",
  "vmess",
  "hysteria2",
  "tuic",
  "anytls",
  "trust-tunnel",
  "ssh"
] as const;

export type ChainExitProtocol = typeof CHAIN_EXIT_PROTOCOLS[number];

export interface SourceConfig {
  id: string;
  name: string;
  url: string;
  urlEncrypted?: string | undefined;
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
  ponteDeviceNames: string[];
  hosts: string[];
  urlRewrite: string[];
  scripts: string[];
  mitm: SurgeMitmConfig;
  rules: string[];
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
  dnsIpv6: boolean;
  dnsEnhancedMode: string;
  dnsFakeIpRange: string;
  defaultNameservers: string[];
  nameservers: string[];
  fallbackNameservers: string[];
  fallbackFilterGeoip: boolean;
  fallbackFilterIpcidr: string[];
  fakeIpFilter: string[];
  ruleProviders: string;
  rules: string[];
}

export interface ClashTunConfig {
  enable: boolean;
  stack: string;
  autoRoute: boolean;
  autoDetectInterface: boolean;
  skipProxy: string[];
}

export interface StashConfig {
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
  tun: StashTunConfig;
  dns: StashDnsConfig;
  ruleProviders: string;
  rules: string[];
  hosts: string[];
  urlRewrite: string[];
  scripts: string[];
  mitm: StashMitmConfig;
}

export interface StashTunConfig {
  enable: boolean;
  stack: string;
  autoRoute: boolean;
  autoDetectInterface: boolean;
  skipProxy: string[];
}

export interface StashDnsConfig {
  enable: boolean;
  listen: string;
  ipv6: boolean;
  enhancedMode: string;
  fakeIpRange: string;
  defaultNameservers: string[];
  nameservers: string[];
  fallbackNameservers: string[];
  fallbackFilterGeoip: boolean;
  fallbackFilterIpcidr: string[];
  fakeIpFilter: string[];
}

export interface StashMitmConfig {
  hostname: string[];
}

export interface ChainConfig {
  exitProxy: {
    protocol: ChainExitProtocol;
    server: string;
    port: number;
    username: string;
    password: string;
  };
  filter: string[];
}

export interface AppConfig {
  version: 1;
  settings: {
    managedBaseUrl: string;
    userAgentSurge: string;
    userAgentClash: string;
    excludeKeywords: string[];
    geoipRenameEnabled: boolean;
    featureTagRules: string[];
    updateCheckEnabled: boolean;
    displayTimeZone: string;
    notificationChannel: NotificationChannel;
    notificationTelegramChatId: string;
    notificationTelegramBotToken: string;
    notificationTelegramWebhookSecret: string;
  };
  groups: Record<string, string>;
  disabledGroups: string[];
  sources: SourceConfig[];
  chain: ChainConfig;
  surge: SurgeConfig;
  clash: ClashConfig;
  stash: StashConfig;
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
  name: string;
  originalName?: string | undefined;
  type: string;
  server: string;
  port?: number | undefined;
  password?: string | undefined;
  uuid?: string | undefined;
  cipher?: string | undefined;
  params: Record<string, ProxyParamValue>;
  raw?: Record<string, ProxyParamValue> | undefined;
  surgeDetail?: string | undefined;
  sourceId?: string | undefined;
  sourceName?: string | undefined;
  featureTags?: string[] | undefined;
  matchLabels?: string[] | undefined;
}

export interface GenerationResult {
  target: Target;
  content: string;
  contentType: string;
  proxyCount: number;
  fetchedSources: number;
  warnings: string[];
}
