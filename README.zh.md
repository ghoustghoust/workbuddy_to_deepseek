# 中文说明

[English](README.md) | 中文

在 **DeepSeek Harness 里使用 WorkBuddy 的积分计费模型**——带前缀缓存友好的上下文管理、真流式输出、本地切号面板。不需要任何外部 API Key，不花美元，一切消耗都走你自己的 WorkBuddy 积分。

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件（官方 bundle 格式，`dsh plugin add` 一条命令安装）。

## 工作原理

```
DSH ──► 本地桥接（本插件，OpenAI 兼容端点 127.0.0.1:37321）
          │
          ├─ wbipc 模式：请求交给本机运行中的 WorkBuddy 桌面端代发，
          │              token 由桌面端自己附加，本地不落盘任何凭证。（默认）
          │
          └─ direct 模式：插件自己持有 OAuth 设备授权 token（与官方 CLI
                          同一流程），直连后端，真流式、无尺寸/时长上限。
                          ▼
               WorkBuddy 后端（积分计费 + 服务端前缀缓存）
```

两种模式都扣 WorkBuddy 积分，本插件不与任何第三方 API 通信。

## 功能

- **双传输模式**：`wbipc`（零凭证落盘，需桌面端运行）/ `direct`（逐字流式、无 640KB/1MiB 限制、不依赖桌面端）。**运行时可切换**：面板按钮、`POST /config/mode`、或直接对 agent 说"切到 direct 模式"，无需重启
- **双站点、可热切**：`cn`（copilot.tencent.com）与 `global`（workbuddy.ai）**各自独立**保存登录凭证（`auths/<站点>/`）、模型目录、每日预算，并连各自桌面端的 IPC 端点。面板按钮或 `POST /config/realm` 切换会同时改写 DSH 的模型层并即时生效；目标站点拿不到目录时**拒绝切换**，不会留着另一个站点的模型继续挂
- **实时模型列表**：暴露哪些模型由该站点自己的目录派生（`/v3/config`，必须用桌面端 UA——只有它返回合并后的产品+账号配置），再按厂商当前选择器白名单过滤，所以官方下架的模型会真的消失、新上的会自动出现，不需要升级插件。档位路由（Auto / Fast / Balanced / …）被排除，因为它们的倍率是浮动的。结果写入 `~/.dsh/cordis.patch.yml`，由 `dsh-hmr` 监听——**DSH 不重启也会换列表**。刷新需要该站点的 direct 凭证：桌面端 IPC 代理不放行目录端点
- **DSH 内嵌设置面板**：以 bundle 方式安装后，DSH 设置里会出现 **「WorkBuddy 桥接」** 板块——当前账号与凭证到期、余额查询、扫码登录/加账号、已存账号一键切换、传输模式与站点热切换、今日消耗 vs 预算、实时价格表。另有浏览器兜底面板 `http://127.0.0.1:37321/login/page`
- **DSH 工具**：`workbuddy_account`，在对话里直接说"切到 xx 账号""查下积分""切到 direct 模式"即可（已在真实会话中端到端验证）
- **每日积分护栏**：超过 `dailyCreditBudget` 自动拒答（0 = 不限制）；**按站点分账**，国内版的花费不会锁死刚登录的国际版账号
- **本地优先**：只监听 127.0.0.1；拒绝浏览器跨站请求与 DNS rebinding；需要鉴权 token；**默认不记录对话内容**
- **缓存收益**：DSH 的会话管理保持提示词前缀稳定，后端前缀缓存从第三轮起命中（实测省约 70% 输入）

## 安装

前置：DeepSeek Harness（桌面端或 dsh CLI）+ WorkBuddy 账号。

```sh
dsh plugin --profile <你的profile> add <本仓库路径>
```

然后配置凭据——插件校验 `WORKBUDDY_PROXY_KEY` 与自己的 `authToken` 一致：

```sh
dsh credentials set WORKBUDDY_PROXY_KEY <首启打印的 authToken>
```

（token 首次启动时自动生成，写在 `index.js` 同目录的 `config.json` 里。）

### 手动安装（不走 bundle 机制）

把 `index.js`、`config.example.json` 拷到 `~/.dsh/plugins/workbuddy-bridge/`，在 profile 的 `cordis.patch.yml` 加一条 insert 指向绝对路径，重启 DeepSeek Harness。

## 第一次使用

1. 启动 DeepSeek Harness，桥接监听 `127.0.0.1:37321`
2. 模型选择器里选 **WorkBuddy (credits)** 分组的模型
3. `wbipc` 模式：保持对应站点的 WorkBuddy 桌面端运行且已登录
   `direct` 模式：在面板（设置 → **WorkBuddy 桥接**，或 `http://127.0.0.1:37321/login/page`）登录一次
4. 之后传输模式和站点都能在面板里直接切，不用重启 Harness。模型列表在启动、每小时、以及每次登录/切站点后刷新——**刷新需要该站点的 direct 凭证**，只用 wbipc 时取不到目录（`/health` 的 `catalogFetchedAt` 可判断列表新旧）

## 配置

所有配置在 `index.js` 同目录的 `config.json`（见 [config.example.json](config.example.json)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `wbipc` | `wbipc` 或 `direct`；运行时可切（面板 / `POST /config/mode` / agent 工具） |
| `realm` | `cn` | `cn`（copilot.tencent.com）/ `global`（workbuddy.ai）；运行时可切（面板 / `POST /config/realm`），切换会同时改写 DSH 模型层 |
| `port` | `37321` | 本地端点端口 |
| `authToken` | 自动生成 | 共享密钥，需与 `WORKBUDDY_PROXY_KEY` 一致 |
| `dailyCreditBudget` | `3000` | 每日积分预算，**按站点各算一份**，`0` = 不限 |
| `perRequestCreditBudget` | `1000` | 单次请求预估积分上限（防 agent 循环失控），`0` = 关 |
| `logRequests` | `true` | 元数据日志（站点、模型、token、缓存命中、积分），不含正文 |
| `logBodies` | `false` | **开启后完整对话正文落盘 `logs/`** |
| `logRetentionDays` | `7` | 日志自动清理天数 |
| `clientVersion` | `5.7.6` | UA 里的桌面端版本段——后端按它决定发哪份目录，写旧了会**静默少一批模型** |
| `cliVersion` | `2.137.1` | 三段式 UA 的 CLI 段 |

## 上下文窗口说明

模型声明里的 `contextWindow` / `maxTokens` 由插件从该站点的实时目录取真实值（`maxInputTokens` / `maxOutputTokens`），不再手写。窗口越大，DSH 触发压缩越晚（约 0.8×窗口），单笔请求的积分消耗上限也就越高——想收紧就在 `~/.dsh/cordis.patch.yml` 的托管块**之外**自己加一层覆盖，插件只重写托管块内的内容。

## 隐私与安全

- [PRIVACY.md](PRIVACY.md) — 数据清单：什么存本地、什么会发出去（答案：只有模型/登录/余额三类请求发给官方后端）
- [SECURITY.md](SECURITY.md) — 威胁模型与缓解措施、已知限制的诚实清单

## 风险与免责

本桥接以官方客户端不会采用的方式调用 WorkBuddy 端点，可能违反平台服务条款并导致账号受限。请使用自己的账号、自担风险。本项目与腾讯、DeepSeek 无任何隶属关系。

## 许可

[MIT + 禁止商用转售附加条款](LICENSE)——禁止售卖 API 访问、出租账号池、打包成收费中转服务。
