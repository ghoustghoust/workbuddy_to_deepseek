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
- **切号面板**：`http://127.0.0.1:37321/login/page` —— 微信扫码登录、多账号存档、一键切换（即时生效无需重启）、余额查询、今日消耗
- **DSH 工具**：注册 `workbuddy_account` 工具，在对话里直接说"切到 xx 账号""查下积分"即可
- **每日积分护栏**：超过 `dailyCreditBudget` 自动拒答（0 = 不限制）
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
3. `wbipc` 模式：保持 WorkBuddy 桌面端运行且已登录
   `direct` 模式：打开 `http://127.0.0.1:37321/login/page` 扫一次码，`config.json` 设 `"mode": "direct"` 后重启 Harness

## 配置

所有配置在 `index.js` 同目录的 `config.json`（见 [config.example.json](config.example.json)）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `wbipc` | `wbipc` 或 `direct`；运行时可切（面板 / `POST /config/mode` / agent 工具） |
| `realm` | `cn` | `cn`（copilot.tencent.com）/ `global`（workbuddy.ai） |
| `port` | `37321` | 本地端点端口 |
| `authToken` | 自动生成 | 共享密钥，需与 `WORKBUDDY_PROXY_KEY` 一致 |
| `dailyCreditBudget` | `3000` | 每日积分预算，`0` = 不限 |
| `perRequestCreditBudget` | `1000` | 单次请求预估积分上限（防 agent 循环失控），`0` = 关 |
| `logRequests` | `true` | 元数据日志（模型、token、缓存命中、积分），不含正文 |
| `logBodies` | `false` | **开启后完整对话正文落盘 `logs/`** |
| `logRetentionDays` | `7` | 日志自动清理天数 |
| `models` | 15 个现役模型 | 暴露的模型 id 列表 |

## 上下文窗口说明

bundle 里的模型声明（`contextWindow` 400K/192K）是**保守值**：直连模式下管道没有尺寸上限，理论上可开到模型真实上限（部分模型 1M），但 DSH 在 0.8×窗口才触发压缩——窗口越大，单笔请求的积分消耗上限越高。按需自行调整 `cordis.patch.yml`。

## 隐私与安全

- [PRIVACY.md](PRIVACY.md) — 数据清单：什么存本地、什么会发出去（答案：只有模型/登录/余额三类请求发给官方后端）
- [SECURITY.md](SECURITY.md) — 威胁模型与缓解措施、已知限制的诚实清单

## 风险与免责

本桥接以官方客户端不会采用的方式调用 WorkBuddy 端点，可能违反平台服务条款并导致账号受限。请使用自己的账号、自担风险。本项目与腾讯、DeepSeek 无任何隶属关系。

## 许可

[MIT + 禁止商用转售附加条款](LICENSE)——禁止售卖 API 访问、出租账号池、打包成收费中转服务。
