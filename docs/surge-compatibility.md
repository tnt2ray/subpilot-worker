# Surge 输出说明 / Output behavior

## 统一订阅与输出

Surge、clash和 sing-box 使用同一个 `/sync/<read_token>/` 订阅入口，基础路径可在设置中修改。UA 仅识别客户端类型，Surge 不再区分 iOS/macOS、正式版/TestFlight、版本号或 build。

配置链接页只显示通用地址。独立客户端路径、`stable` / `tf` Tag 及旧文件名入口不再提供。此前使用这些地址的客户端需要重新复制通用地址。订阅入口可省略末尾 `/`，订阅与规则下载均不接受查询参数。

Surge 订阅按保存的客户端设置生成，`#!MANAGED-CONFIG` 始终引用通用地址，不使用版本档位。

All clients share the universal subscription URL. User-Agent selects the client family only. Surge uses one rendering path across platforms, versions, and release channels. Dedicated paths and version tags are removed; generated automatic update URLs always use the universal entry.

## 功能与检查

策略组由三端独立维护。旧共享组迁移时，Surge 的 `url-test` 转为 `smart`；Surge 输出仍兼容这一转换；clash 和 sing-box 保持各自自动测速类型。转换后的 smart 组仅允许代理节点成员，内置策略与嵌套组会产生阻断诊断。Smart 的 `interval` 不生效，详见 [Smart 组文档](https://manual.nssurge.com/policy-groups/smart.html)。

Groups are independent per client. Migrating shared groups converts Surge `url-test` to `smart`; Surge subscriptions retain this conversion for compatibility. Other clients keep their own definitions and automatic-testing types. Validation checks the emitted smart type and blocks built-in policies or nested groups as members. Smart ignores `interval`.

已接入的 Surge 功能按保存的设置输出，包括 Smart 策略组、Snell、AnyTLS、TrustTunnel、HTTP/2 CONNECT、MASQUE、Tailscale、策略组链式出口、Hosts 和事件脚本，不再查询版本能力表。

不支持的节点和跨客户端功能仍按各输出端的语义进行适配。缺少正在引用的策略、无法保留的链式关系、空组、无效规则或 DNS 语义仍会阻断输出。这次调整只移除版本判断，不移除协议转换、引用或配置校验，也不改写已保存的配置。

Generated output follows the saved settings without filtering features by Surge version. Protocol conversion and configuration validation remain active. The application does not verify the installed Surge version; support for a configured feature is determined by the client importing it.

## 配置参考

- 协议与参数：[代理概览](https://manual.nssurge.com/policies/overview.html)、[HTTP](https://manual.nssurge.com/policies/http.html)、[MASQUE](https://manual.nssurge.com/policies/masque.html)、[TrustTunnel](https://manual.nssurge.com/policies/trust-tunnel.html)、[Snell](https://manual.nssurge.com/policies/snell.html)。
- 策略与会话：[策略组参数](https://manual.nssurge.com/policy-groups/parameters.html)、[Smart 组](https://kb.nssurge.com/surge-knowledge-base/guidelines/smart-group.md)、[Tailscale](https://manual.nssurge.com/policies/tailscale.html)。

本次调整无需迁移 KV 数据或轮换 Secrets。更新功能或订阅行为时同步中英文 README。
