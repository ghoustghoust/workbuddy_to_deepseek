# 安全说明（SECURITY）

最后更新：2026-10-07

## 威胁模型

这是一个**只监听 127.0.0.1** 的本地服务，处理两类资产：WorkBuddy 登录凭证、积分。攻击者视角：

| 威胁 | 缓解 |
|---|---|
| 恶意网页通过浏览器向 `127.0.0.1:37321` 发请求烧积分（fetch 到 localhost 允许发出，只是读不到响应） | ① 拒绝一切 `Sec-Fetch-Site: cross-site` 请求；② 面板以外的端点要求 `Authorization: Bearer <authToken>`；③ 同源豁免仅覆盖面板自身的 fetch（外部页面无法伪造 same-origin） |
| DNS rebinding（恶意域名解析到 127.0.0.1 绕过同源） | 校验 `Host` 头必须是 `127.0.0.1` / `localhost` / `[::1]` |
| 本机其他进程/恶意软件滥用端点 | 要求 Bearer token（首启自动生成 192-bit 随机值，存 `config.json`）。**注意：与本插件同权限运行的进程本就能读 `auth.json`，本地进程隔离不在本插件威胁模型内** |
| 凭证文件泄露 | `auth.json` / `auths/*.json` / `state.json` 权限 0600；`.gitignore` 排除；wbipc 模式完全不落盘 |
| 对话内容泄露 | 默认不落盘正文（`logBodies: false`）；日志默认 7 天清理 |
| 积分失控（agent 循环、重试风暴） | `dailyCreditBudget` 每日护栏，超限返回 429；直连模式客户端断开会向上游 abort，提前止损 |
| 依赖供应链 | 运行时零第三方依赖（仅 Node 内置模块）；`@deepseek-ai/dsh-tools` 为可选集成，缺失时自动降级 |

## 已知限制（诚实清单）

- **token 明文落盘**：直连模式的 refreshToken 是账号长期凭证，以明文存于 `auth.json`（权限 0600）。Windows 下可用 DPAPI 加密——列为 roadmap，当前版本依赖文件权限与用户自觉。对凭证敏感的用户请用 wbipc 模式（零落盘）
- **日志的 `prefixTail`**：是消息序列的滚动哈希前缀（不可逆），但多轮哈希序列理论上可用于会话关联分析。介意请设 `logRequests: false`
- **面板页免鉴权**：`/login/page` 本身不校验 token（否则页面里的 JS 无法携带它）。它只读不写，且写操作全部要求 same-origin 或 Bearer
- **风控对抗不做**：本插件不做 UA 轮换、指纹伪装、多号自动轮换——这些是封号加速器，不是安全特性

## 上报漏洞

不要在公开 issue 里描述可被利用的细节。请通过仓库的 Security Advisory（Security → Report a vulnerability）私下上报，72 小时内回应。
