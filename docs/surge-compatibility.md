# Surge 兼容档位 / Compatibility profiles

## 链接与版本

`/sync/<read_token>/surge/stable/` 使用正式版能力；`/sync/<read_token>/surge/tf/` 使用 TestFlight / Mac Beta 能力。两者共享保存的 Surge 设置。Tag 区分大小写，保留末尾 `/`；未知 Tag 拒绝访问。`/surge/` 默认正式版。通用订阅地址与旧配置文件地址已移除。

输出客户端、Surge 版本与渠道均由独立地址决定，不从 UA 推断。管理页预览必须指定 `target`，其 `profile=stable|tf` 参数选择同一个能力档位；这些参数仅用于预览 API，订阅地址仍拒绝查询参数。自动更新地址保留 Tag，切换预览档位会使旧预览失效。

核实日期：2026-09-05。

| 档位 / Profile | iOS 基线 | macOS 基线 |
| --- | --- | --- |
| `stable` | 5.22.0 | 6.9.0（正式版 build 12250） |
| `tf` | 已核实 build 3823 | 已核实 build 12250 |

iOS 正式版本以 [App Store](https://apps.apple.com/us/app/surge-5/id1442620678) 为准，Mac 正式版本以 [官方更新源](https://nssurge.com/mac/latest/appcast-signed.xml) 为准。TF 档位是已核实能力的固定快照，不承诺跟随最新测试构建；iOS 的 TF 营销版本（例如 5.102.0）不能直接换算正式版本。

Profiles select a fixed capability snapshot, not the installed client version. Untagged Surge URLs use stable. Both platforms must support a feature before their shared profile enables it. Upgrade older clients to the documented baseline. No UA sample or KV migration is required.

## 已接入能力

能力注册表在 `src/surge-capabilities.ts`。正式版按版本门槛检查，TF 按已观察到的保守 build 门槛检查；表中的 build 是支持依据，不一定是功能最早出现的构建。

| 能力 | iOS 正式版门槛 | macOS 正式版门槛 | TF build 门槛（iOS / Mac） |
| --- | --- | --- | --- |
| Smart 组 | 5.11.0 | 5.7.0 | 3730 / 7210 |
| Snell 5 | 5.15.0 | 6.0.0 | 3730 / 7210 |
| AnyTLS | 5.17.0 | 6.4.3 | 3730 / 10320 |
| TrustTunnel | 5.18.0 | 6.4.4 | 3730 / 10661 |
| HTTP/2 CONNECT、自定义请求头 | 5.20.0 | 6.6.0 | 3765 / 11270 |
| Snell 6、Tailscale | 5.20.0 | 6.7.0 | 3765 / 11730 |
| Tailscale idle-keepalive | 5.21.0 | 6.8.0 | 3791 / 11990 |
| MASQUE、HTTP/2 UDP、TrustTunnel HTTP/3 | 5.22.0 | 6.9.0 | 3813 / 12040 |
| 策略组 underlying-proxy | 5.22.0 | 6.9.0 | 3813 / 12040 |
| 策略组 icon-url | 5.20.0 | 6.5.0 | 3765 / 10960 |
| Host 别名的独立 DNS | 5.22.0 | 6.9.0 | 3820 / 12080 |
| engine-started / profile-reloaded 事件脚本 | 5.22.0 | 6.9.0 | 3823 / 12250 |

以上能力目前均已进入当前正式版，因此 `stable` 与 `tf` 可能只在档位标记和自动更新 URL 上不同。Snell 服务端的 beta 状态不等于 Surge 客户端只在 TF 支持该协议。

不支持的节点整体省略并报告诊断，避免删除必需传输参数后改变连接语义；可选装饰参数可以省略。缺少正在引用的策略、无法保留的链式关系或 DNS 语义会阻断输出。保存的原始配置不会因选择档位而丢失字段。

该表覆盖应用已接入的能力，不是任意 Surge 原生文本的完整版本校验器。手填 General、脚本及其他原生扩展中的未知新语法仍需按目标版本核实。

## 依据与维护

- 协议与参数：[代理概览](https://manual.nssurge.com/policies/overview.html)、[HTTP](https://manual.nssurge.com/policies/http.html)、[MASQUE](https://manual.nssurge.com/policies/masque.html)、[TrustTunnel](https://manual.nssurge.com/policies/trust-tunnel.html)、[Snell](https://manual.nssurge.com/policies/snell.html)。
- 策略与会话：[策略组参数](https://manual.nssurge.com/policy-groups/parameters.html)、[Smart 组](https://kb.nssurge.com/surge-knowledge-base/guidelines/smart-group.md)、[Tailscale](https://manual.nssurge.com/policies/tailscale.html)。
- 当前正式功能：[iOS App Store 更新说明](https://apps.apple.com/us/app/surge-5/id1442620678)、[Mac 更新说明](https://nssurge.com/support/mac/release-notes)。
- iOS TF build 核对辅助材料：[开发者 TestFlight 更新邮件转录归档](https://t.me/s/SurgeTestFlightChangelog)。该归档不是官方账号；语义仍以官方文档与正式更新说明为准。保守采用已观察构建，特别是 idle-keepalive 使用 build 3791 之后的语义（省略、0、-1 均保持会话）。

新增 TF 专属能力时，在注册表中登记每个平台的已核实 build，将尚未正式发布的平台 `version` 设为 `null`，并在对应渲染入口使用同一能力检查。只有核实过的构建才能提升 `tf` 基线。功能正式发布后填写正式版本门槛，并根据项目支持范围更新 `stable` 基线。两平台支持不一致时暂不启用其共用档位。

维护能力表时同步中文与英文 README。请求处理中不联网查询版本，不把上游更新自动转化为新增输出能力。`#!REQUIREMENT` 是逐行条件，不作为配置全局最低版本声明；生成文件用注释标明兼容基线。
