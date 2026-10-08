# 安全说明（SECURITY）

最后更新：2026-10-08

## 威胁模型

这是一个**只监听 127.0.0.1** 的本地服务，处理两类资产：WorkBuddy 登录凭证、积分。攻击者视角：

| 威胁 | 缓解 |
|---|---|
| 恶意网页通过浏览器向 `127.0.0.1:37321` 发请求烧积分（fetch 到 localhost 允许发出，只是读不到响应） | ① 拒绝一切 `Sec-Fetch-Site: cross-site` 请求；② 面板以外的端点要求 `Authorization: Bearer <authToken>`；③ 同源豁免仅覆盖面板自身的 fetch（外部页面无法伪造 same-origin） |
| DNS rebinding（恶意域名解析到 127.0.0.1 绕过同源） | 校验 `Host` 头必须是 `127.0.0.1` / `localhost` / `[::1]` |
| 本机其他进程/恶意软件滥用端点 | 要求 Bearer token（首启自动生成 192-bit 随机值，存 `config.json`）。**注意：与本插件同权限运行的进程本就能读 `auths/<realm>/current.json`，也能直接改 `Sec-Fetch-Site` 头，本地进程隔离不在本插件威胁模型内** |
| 凭证文件泄露 | `auths/<realm>/current.json`、`auths/<realm>/<uid>.json`、`state-<realm>.json` 权限 0600；`.gitignore` 排除；wbipc 模式完全不落盘 |
| 对话内容泄露 | 默认不落盘正文（`logBodies: false`）；日志默认 7 天清理 |
| 积分失控（agent 循环、重试风暴） | `dailyCreditBudget` 每日护栏（**按 realm 分账**，国内版的花费不会锁死国际版账号），超限返回 429；直连模式客户端断开会向上游 abort，提前止损 |
| 上游目录被投毒 → 篡改宿主配置 | 暴露给 DSH 的模型列表会写进 `~/.dsh/cordis.patch.yml`（被 dsh-hmr 监听）。因此模型 id 过白名单、上下文/输出上限强制为有限整数、所有标量走带引号的 JSON 风格转义（含 U+0085/U+2028/U+2029），写入用 `wx` 独占临时文件 + rename，且标记块不完整/有杂散标记时**拒绝覆写**并在 `/health` 报 `refused` |
| 依赖供应链 | 运行时零第三方依赖（仅 Node 内置模块）；`@deepseek-ai/dsh-tools` 为可选集成，缺失时自动降级 |

## DSH 内嵌面板的路由（`/workbuddy/*`）

安装成 bundle 后，面板通过 DSH 自带的 web 服务器与我们通信（避免跨源）。由于该服务器在「公网部署」场景下可能不止监听回环地址，路由的鉴权模型是：

- 除 `/workbuddy/bootstrap` 外，全部要求 `Authorization: Bearer <authToken>`
- `/workbuddy/bootstrap` 只把 token 交给 `Sec-Fetch-Site: same-origin` 的页面（浏览器无法伪造该头，跨站页面拿到的是 `cross-site` → 403）
- 任何响应都不返回 accessToken / refreshToken，只返回昵称、uid、到期时间、价格与消耗计数
- 这些路由做「切号 / 切模式 / 切站点 / 发起扫码 / 查价」，不代发模型请求。**但 `POST /realm` 会改写 `~/.dsh/cordis.patch.yml`**（DSH 的模型层），因此它是控制面写入而非只读查询——上表最后一条的转义/白名单/拒绝覆写规则就是为它设的。真正烧积分仍需 37321 上的 LLM 端点，那边强制 Bearer + 仅回环

## 已知限制（诚实清单）

- **token 明文落盘**：直连模式的 refreshToken 是账号长期凭证，以明文存于 `auths/<realm>/current.json`（权限 0600）。Windows 下可用 DPAPI 加密——列为 roadmap，当前版本依赖文件权限与用户自觉。对凭证敏感的用户请用 wbipc 模式（零落盘）
- **同源豁免对非浏览器客户端无效**：`Sec-Fetch-Site: same-origin` 只有浏览器不可伪造；本机任意进程都能带上它调用 `/config/mode`、`/config/realm`、`/auth/switch` 乃至 `/v1/chat/completions` 而不需要 token。这类进程同样能直接读 `config.json` 拿到 token，所以没有额外越权，但**如果你要把 37321 暴露给回环以外的地址，必须先补上真正的鉴权**
- **模型列表依赖 direct 凭证**：wbipc 的桌面端代理只放行 `content-type`/`accept` 两个头，取不到按 UA 分发的模型目录。因此没有该 realm 的 direct 登录时，列表会停在上一次快照（`/health` 的 `catalogFetchedAt` 可判断新旧）
- **`WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR`** 会把 IPC 钉死在某个目录，此时切换 realm 不会改连另一个桌面端；`/health` 的 `ipcPinned` 与切站点返回的 warnings 会明确指出
- **日志的 `prefixTail`**：是消息序列的滚动哈希前缀（不可逆），但多轮哈希序列理论上可用于会话关联分析。介意请设 `logRequests: false`
- **面板页免鉴权**：`/login/page` 本身不校验 token（否则页面里的 JS 无法携带它）。它只读不写，且写操作全部要求 same-origin 或 Bearer
- **风控对抗不做**：本插件不做 UA 轮换、指纹伪装、多号自动轮换——这些是封号加速器，不是安全特性

## 上报漏洞

不要在公开 issue 里描述可被利用的细节。请通过仓库的 Security Advisory（Security → Report a vulnerability）私下上报，72 小时内回应。
