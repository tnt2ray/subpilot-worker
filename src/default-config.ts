import { CHAIN_EXIT_PROXY_NAME, STATIC_EXIT_GROUP_NAME, type AppConfig } from "./types";
import { DEFAULT_DISPLAY_TIME_ZONE } from "./util";

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  settings: {
    managedBaseUrl: "",
    userAgentSurge: "Surge iOS/3727",
    userAgentClash: "clash-verge/v2.5.1",
    excludeKeywords: ["过期", "剩余", "官网", "直接连接", "购买", "漏洞", "备用", "登陆", "工作室", "客服"],
    geoipRenameEnabled: true,
    featureTagRules: [
      "Netflix=netflix,nf,奈飞",
      "Disney=disney,disney+,disneyplus,d+,迪士尼",
      "AI=ai,claude,gemini,chatgpt,openai,gpt",
      "YouTube=youtube,yt",
      "HBO=hbo,max",
      "Prime=prime,amazon"
    ],
    updateCheckEnabled: false,
    displayTimeZone: DEFAULT_DISPLAY_TIME_ZONE,
    notificationChannel: "off",
    notificationTelegramChatId: "",
    notificationTelegramBotToken: "",
    notificationTelegramWebhookSecret: ""
  },
  groups: {
    Proxy: "select, Auto, {all exclude=Chain}",
    Auto: "url-test, {all exclude=Chain}, url=https://www.gstatic.com/generate_204, interval=600",
    Disney: "select, {all filter=Disney}",
    [STATIC_EXIT_GROUP_NAME]: `url-test, {all filter=Chain exclude=${CHAIN_EXIT_PROXY_NAME}}, url=https://www.gstatic.com/generate_204, interval=600`
  },
  disabledGroups: [],
  sources: [],
  chain: {
    exitProxy: {
      protocol: "socks5",
      server: "",
      port: 1080,
      username: "",
      password: ""
    },
    filter: ["JP", "KR", "TW"]
  },
  surge: {
    skipProxy: [
      "127.0.0.1",
      "192.168.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "100.64.0.0/10",
      "localhost",
      "*.local",
      "e.crashlytics.com",
      "captive.apple.com",
      "::ffff:0:0:0:0/1",
      "::ffff:128:0:0:0/1"
    ],
    dnsServer: [
      "223.5.5.5",
      "223.6.6.6",
      "1.1.1.1",
      "8.8.8.8",
      "1.0.0.1",
      "8.8.4.4"
    ],
    alwaysRealIp: [
      "%APPEND% dns.msftncsi.com",
      "*.srv.nintendo.net",
      "*.stun.playstation.net",
      "xbox.*.microsoft.com",
      "*.xboxlive.com",
      "*.turn.twilio.com",
      "*.stun.twilio.com",
      "stun.syncthing.net",
      "stun.*"
    ],
    managedConfigIntervalSeconds: 43200,
    internetTestUrl: "http://wifi.vivo.com.cn/generate_204",
    proxyTestUrl: "http://cp.cloudflare.com/generate_204",
    showErrorPageForReject: true,
    ipv6: true,
    ipv6Vif: "auto",
    allowWifiAccess: false,
    tunExcludedRoutes: [
      "192.168.0.0/16",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "239.255.255.250/32"
    ],
    encryptedDnsServer: [
      "https://1.1.1.1/dns-query",
      "quic://223.5.5.5",
      "quic://223.6.6.6",
      "https://223.5.5.5/dns-query"
    ],
    wifiAssist: false,
    excludeSimpleHostnames: true,
    encryptedDnsFollowOutboundMode: true,
    ponteDeviceNames: [],
    hosts: [],
    urlRewrite: [
      "^https?:\\/\\/.+\\.pangolin-sdk-toutiao\\.com\\/api\\/ad\\/union\\/sdk\\/(get_ads|stats|settings)\\/ - reject",
      "^https?:\\/\\/.+\\.pglstatp-toutiao\\.com\\/.+\\/toutiao\\.mp4 - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/(obj|img)\\/(ad-app-package|ad)\\/.+ - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/(obj|img)\\/web\\.business\\.image\\/.+ - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/obj\\/ad-pattern\\/renderer - reject",
      "^https?:\\/\\/gurd\\.snssdk\\.com\\/src\\/server\\/v3\\/package - reject",
      "^https?:\\/\\/.+\\.byteimg.com/tos-cn-i-1yzifmftcy\\/(.+)-jpeg\\.jpeg - reject",
      "^https?:\\/\\/.+\\.pstatp\\.com\\/obj\\/mosaic-legacy\\/.+\\?from\\=ad - reject",
      "^https?:\\/\\/.+\\.pstatp\\.com\\/bytecom\\/resource\\/track-log\\/src\\/.+ - reject",
      "^https?:\\/\\/.+\\.snssdk\\.com\\/video\\/play\\/1\\/toutiao\\/.+\\/mp4 - reject",
      "^https?:\\/\\/.+\\.snssdk.com\\/api\\/ad\\/.+ - reject",
      "^http:\\/\\/.+\\.byteimg\\.com\\/ad-app-package - reject",
      "^http:\\/\\/.+\\.byteimg\\.com\\/web\\.business\\.image - reject",
      "^https?:\\/\\/.+?\\.snssdk\\.com\\/motor\\/operation\\/activity\\/display\\/config\\/V2\\/ - reject",
      "^https?:\\/\\/(ditu|maps).google\\.cn https://maps.google.com 302",
      "^https?:\\/\\/(www.)?(g|google)\\.cn https://www.google.com 302"
    ],
    scripts: [
      "京东_开屏去广告 = type=http-response,requires-body=1,max-size=0,pattern=^https?:\\/\\/api\\.m\\.jd\\.com\\/client\\.action\\?functionId=start,script-path=https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/script/startup/startup.js",
      "美团外卖_开屏去广告 = type=http-response,requires-body=1,max-size=0,pattern=^https?:\\/\\/wmapi\\.meituan\\.com\\/api\\/v\\d+\\/loadInfo?,script-path=https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/script/startup/startup.js"
    ],
    mitm: {
      skipServerCertVerify: true,
      h2: true,
      hostname: [
        "wmapi.meituan.com",
        "api.m.jd.com",
        "*.pstatp.com",
        "*.pstatp.com.*",
        "*default.ixigua.com",
        "adim.pinduoduo.com",
        "*.fqnovelvod.com",
        "*.google.cn",
        "*.pangolin-sdk-toutiao.com",
        "*.pglstatp-toutiao.com",
        "gurd.snssdk.com",
        "*.byteimg.com",
        "*.snssdk.com",
        "ditu.google.cn",
        "maps.google.cn",
        "g.cn",
        "www.g.cn",
        "google.cn",
        "www.google.cn"
      ],
      caPassphrase: "",
      caP12: ""
    },
    rules: [
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Advertising/Advertising.list,REJECT",
      "PROCESS-NAME,/Applications/DingTalk.app/,DIRECT",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/DingTalk/DingTalk.list,DIRECT,extended-matching",
      "RULE-SET,https://ruleset.skk.moe/List/non_ip/microsoft_cdn.conf,DIRECT",
      "RULE-SET,https://ruleset.skk.moe/List/non_ip/direct.conf,DIRECT,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/GaoDe/GaoDe.list,DIRECT,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/WeChat/WeChat.list,DIRECT,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/BiliBili/BiliBili.list,DIRECT,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Apple/Apple_All_No_Resolve.list,Proxy,extended-matching",
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Google/Google.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/OpenAI/OpenAI.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Gemini/Gemini.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Anthropic/Anthropic.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Claude/Claude.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Bing/Bing.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/YouTube/YouTube.list,Proxy,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Docker/Docker.list,Proxy,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Python/Python.list,Proxy,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/YouTubeMusic/YouTubeMusic.list,Proxy,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/GitHub/GitHub.list,Proxy,extended-matching",
      `RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Twitter/Twitter.list,${STATIC_EXIT_GROUP_NAME},extended-matching`,
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Xbox/Xbox.list,Proxy",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Scholar/Scholar.list,Proxy",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Npmjs/Npmjs.list,Proxy",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Steam/Steam.list,Proxy,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Amazon/Amazon.list,Proxy,extended-matching",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Pixiv/Pixiv.list,Proxy,extended-matching",
      "RULE-SET,https://ruleset.skk.moe/List/ip/telegram.conf,Proxy,extended-matching",
      "PROCESS-NAME,Telegram,Proxy",
      "DOMAIN-SET,https://ruleset.skk.moe/List/domainset/download.conf,Proxy",
      "RULE-SET,https://ruleset.skk.moe/List/non_ip/microsoft.conf,Proxy",
      "RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Disney/Disney.list,Disney",
      "RULE-SET,LAN,DIRECT",
      "GEOIP,CN,DIRECT",
      "FINAL,DIRECT"
    ]
  },
  clash: {
    port: 7890,
    socksPort: 7891,
    mixedPort: 7892,
    allowLan: false,
    mode: "Rule",
    logLevel: "info",
    ipv6: true,
    unifiedDelay: true,
    tcpConcurrent: true,
    externalController: "0.0.0.0:9090",
    tun: {
      enable: true,
      stack: "system",
      autoRoute: true,
      autoDetectInterface: true,
      skipProxy: [
        "127.0.0.1/8",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "172.16.0.0/12"
      ]
    },
    dnsEnabled: true,
    dnsListen: "0.0.0.0:53",
    dnsIpv6: true,
    dnsEnhancedMode: "fake-ip",
    dnsFakeIpRange: "198.18.0.1/16",
    defaultNameservers: [
      "223.5.5.5",
      "1.1.1.1"
    ],
    nameservers: [
      "quic://223.5.5.5/dns-query",
      "quic://223.6.6.6/dns-query",
      "https://dns.alidns.com/dns-query",
      "https://doh.pub/dns-query"
    ],
    fallbackNameservers: [
      "https://1.1.1.1/dns-query",
      "https://8.8.8.8/dns-query",
      "tcp://8.8.4.4",
      "tcp://1.0.0.1"
    ],
    fallbackFilterGeoip: true,
    fallbackFilterIpcidr: [
      "240.0.0.0/4"
    ],
    fakeIpFilter: [
      "dns.msftncsi.com",
      "+.srv.nintendo.net",
      "+.stun.playstation.net",
      "xbox.*.microsoft.com",
      "+.xboxlive.com",
      "+.turn.twilio.com",
      "+.stun.twilio.com",
      "stun.syncthing.net",
      "stun.*",
      "+.local",
      "localhost",
      "e.crashlytics.com",
      "captive.apple.com",
      "msftconnecttest.com",
      "+.battlenet.com.cn"
    ],
    ruleProviders: `rule-providers:
  Advertising:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising.yaml
    path: ./rules/Advertising.yaml
    interval: 86400
  Advertising_Domain:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/refs/heads/master/rule/Clash/Advertising/Advertising_Domain.yaml
    path: ./rules/Advertising_Domain.yaml
    interval: 86400
  DingTalk:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/DingTalk/DingTalk.yaml
    path: ./rules/DingTalk.yaml
    interval: 86400
  Google:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Google/Google.yaml
    path: ./rules/Google.yaml
    interval: 86400
  OpenAI:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/OpenAI/OpenAI.yaml
    path: ./rules/OpenAI.yaml
    interval: 86400
  Gemini:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Gemini/Gemini.yaml
    path: ./rules/Gemini.yaml
    interval: 86400
  Bing:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Bing/Bing.yaml
    path: ./rules/Bing.yaml
    interval: 86400
  YouTube:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/YouTube/YouTube.yaml
    path: ./rules/YouTube.yaml
    interval: 86400
  Telegram:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Telegram/Telegram.yaml
    path: ./rules/Telegram.yaml
    interval: 86400
  Disney:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Disney/Disney.yaml
    path: ./rules/Disney.yaml
    interval: 86400
  Twitter:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Twitter/Twitter.yaml
    path: ./rules/Twitter.yaml
    interval: 86400
  GitHub:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/GitHub/GitHub.yaml
    path: ./rules/GitHub.yaml
    interval: 86400
  Steam:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Steam/Steam.yaml
    path: ./rules/Steam.yaml
    interval: 86400
  Scholar:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Scholar/Scholar.yaml
    path: ./rules/Scholar.yaml
    interval: 86400
  Npmjs:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Npmjs/Npmjs.yaml
    path: ./rules/Npmjs.yaml
    interval: 86400`,
    rules: [
      "PROCESS-NAME,Telegram,Proxy",
      "RULE-SET,Advertising,REJECT",
      "RULE-SET,Advertising_Domain,REJECT",
      "RULE-SET,DingTalk,DIRECT",
      `RULE-SET,Google,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,OpenAI,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Gemini,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Bing,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Twitter,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Scholar,${STATIC_EXIT_GROUP_NAME}`,
      "RULE-SET,YouTube,Proxy",
      "RULE-SET,Telegram,Proxy",
      "RULE-SET,GitHub,Proxy",
      "RULE-SET,Steam,Proxy",
      "RULE-SET,Npmjs,Proxy",
      "RULE-SET,Disney,Disney",
      "GEOIP,PRIVATE,DIRECT",
      "GEOIP,CN,DIRECT",
      "MATCH,Proxy"
    ]
  },
  stash: {
    port: 7890,
    socksPort: 7891,
    mixedPort: 7892,
    allowLan: false,
    mode: "Rule",
    logLevel: "info",
    ipv6: true,
    unifiedDelay: true,
    tcpConcurrent: true,
    externalController: "0.0.0.0:9090",
    tun: {
      enable: true,
      stack: "system",
      autoRoute: true,
      autoDetectInterface: true,
      skipProxy: [
        "127.0.0.1/8",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "172.16.0.0/12"
      ]
    },
    dns: {
      enable: true,
      listen: "0.0.0.0:53",
      ipv6: true,
      enhancedMode: "fake-ip",
      fakeIpRange: "198.18.0.1/16",
      defaultNameservers: [
        "223.5.5.5",
        "1.1.1.1"
      ],
      nameservers: [
        "quic://223.5.5.5/dns-query",
        "quic://223.6.6.6/dns-query",
        "https://dns.alidns.com/dns-query",
        "https://doh.pub/dns-query"
      ],
      fallbackNameservers: [
        "https://1.1.1.1/dns-query",
        "https://8.8.8.8/dns-query",
        "tcp://8.8.4.4",
        "tcp://1.0.0.1"
      ],
      fallbackFilterGeoip: true,
      fallbackFilterIpcidr: [
        "240.0.0.0/4"
      ],
      fakeIpFilter: [
        "dns.msftncsi.com",
        "+.srv.nintendo.net",
        "+.stun.playstation.net",
        "xbox.*.microsoft.com",
        "+.xboxlive.com",
        "+.turn.twilio.com",
        "+.stun.twilio.com",
        "stun.syncthing.net",
        "stun.*",
        "+.local",
        "localhost",
        "e.crashlytics.com",
        "captive.apple.com",
        "msftconnecttest.com",
        "+.battlenet.com.cn"
      ]
    },
    ruleProviders: `rule-providers:
  Advertising:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising.yaml
    path: ./rules/Advertising.yaml
    interval: 86400
  Advertising_Domain:
    type: http
    behavior: domain
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/refs/heads/master/rule/Clash/Advertising/Advertising_Domain.yaml
    path: ./rules/Advertising_Domain.yaml
    interval: 86400
  DingTalk:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/DingTalk/DingTalk.yaml
    path: ./rules/DingTalk.yaml
    interval: 86400
  Google:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Google/Google.yaml
    path: ./rules/Google.yaml
    interval: 86400
  OpenAI:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/OpenAI/OpenAI.yaml
    path: ./rules/OpenAI.yaml
    interval: 86400
  Gemini:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Gemini/Gemini.yaml
    path: ./rules/Gemini.yaml
    interval: 86400
  Bing:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Bing/Bing.yaml
    path: ./rules/Bing.yaml
    interval: 86400
  YouTube:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/YouTube/YouTube.yaml
    path: ./rules/YouTube.yaml
    interval: 86400
  Telegram:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Telegram/Telegram.yaml
    path: ./rules/Telegram.yaml
    interval: 86400
  Disney:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Disney/Disney.yaml
    path: ./rules/Disney.yaml
    interval: 86400
  Twitter:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Twitter/Twitter.yaml
    path: ./rules/Twitter.yaml
    interval: 86400
  GitHub:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/GitHub/GitHub.yaml
    path: ./rules/GitHub.yaml
    interval: 86400
  Steam:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Steam/Steam.yaml
    path: ./rules/Steam.yaml
    interval: 86400
  Scholar:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Scholar/Scholar.yaml
    path: ./rules/Scholar.yaml
    interval: 86400
  Npmjs:
    type: http
    behavior: classical
    url: https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Npmjs/Npmjs.yaml
    path: ./rules/Npmjs.yaml
    interval: 86400`,
    rules: [
      "PROCESS-NAME,Telegram,Proxy",
      "RULE-SET,Advertising,REJECT",
      "RULE-SET,Advertising_Domain,REJECT",
      "RULE-SET,DingTalk,DIRECT",
      `RULE-SET,Google,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,OpenAI,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Gemini,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Bing,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Twitter,${STATIC_EXIT_GROUP_NAME}`,
      `RULE-SET,Scholar,${STATIC_EXIT_GROUP_NAME}`,
      "RULE-SET,YouTube,Proxy",
      "RULE-SET,Telegram,Proxy",
      "RULE-SET,GitHub,Proxy",
      "RULE-SET,Steam,Proxy",
      "RULE-SET,Npmjs,Proxy",
      "RULE-SET,Disney,Disney",
      "GEOIP,PRIVATE,DIRECT",
      "GEOIP,CN,DIRECT",
      "MATCH,Proxy"
    ],
    hosts: [],
    urlRewrite: [
      "^https?:\\/\\/.+\\.pangolin-sdk-toutiao\\.com\\/api\\/ad\\/union\\/sdk\\/(get_ads|stats|settings)\\/ - reject",
      "^https?:\\/\\/.+\\.pglstatp-toutiao\\.com\\/.+\\/toutiao\\.mp4 - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/(obj|img)\\/(ad-app-package|ad)\\/.+ - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/(obj|img)\\/web\\.business\\.image\\/.+ - reject",
      "^https?:\\/\\/.+\\.(pglstatp-toutiao|pstatp)\\.com\\/obj\\/ad-pattern\\/renderer - reject",
      "^https?:\\/\\/gurd\\.snssdk\\.com\\/src\\/server\\/v3\\/package - reject",
      "^https?:\\/\\/.+\\.byteimg.com/tos-cn-i-1yzifmftcy\\/(.+)-jpeg\\.jpeg - reject",
      "^https?:\\/\\/.+\\.pstatp\\.com\\/obj\\/mosaic-legacy\\/.+\\?from\\=ad - reject",
      "^https?:\\/\\/.+\\.pstatp\\.com\\/bytecom\\/resource\\/track-log\\/src\\/.+ - reject",
      "^https?:\\/\\/.+\\.snssdk\\.com\\/video\\/play\\/1\\/toutiao\\/.+\\/mp4 - reject",
      "^https?:\\/\\/.+\\.snssdk.com\\/api\\/ad\\/.+ - reject",
      "^http:\\/\\/.+\\.byteimg\\.com\\/ad-app-package - reject",
      "^http:\\/\\/.+\\.byteimg\\.com\\/web\\.business\\.image - reject",
      "^https?:\\/\\/.+?\\.snssdk\\.com\\/motor\\/operation\\/activity\\/display\\/config\\/V2\\/ - reject",
      "^https?:\\/\\/(ditu|maps).google\\.cn https://maps.google.com 302",
      "^https?:\\/\\/(www.)?(g|google)\\.cn https://www.google.com 302"
    ],
    scripts: [
      "京东_开屏去广告 = type=http-response,requires-body=1,max-size=0,pattern=^https?:\\/\\/api\\.m\\.jd\\.com\\/client\\.action\\?functionId=start,script-path=https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/script/startup/startup.js",
      "美团外卖_开屏去广告 = type=http-response,requires-body=1,max-size=0,pattern=^https?:\\/\\/wmapi\\.meituan\\.com\\/api\\/v\\d+\\/loadInfo?,script-path=https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/script/startup/startup.js"
    ],
    mitm: {
      hostname: [
        "wmapi.meituan.com",
        "api.m.jd.com",
        "*.pstatp.com",
        "*.pstatp.com.*",
        "*default.ixigua.com",
        "adim.pinduoduo.com",
        "*.fqnovelvod.com",
        "*.google.cn",
        "*.pangolin-sdk-toutiao.com",
        "*.pglstatp-toutiao.com",
        "gurd.snssdk.com",
        "*.byteimg.com",
        "*.snssdk.com",
        "ditu.google.cn",
        "maps.google.cn",
        "g.cn",
        "www.g.cn",
        "google.cn",
        "www.google.cn"
      ]
    }
  }
};
