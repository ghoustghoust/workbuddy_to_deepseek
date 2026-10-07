# dsh-workbuddy-bridge

**English** | [中文](README.zh.md)

Use your **WorkBuddy credit-billed models inside DeepSeek Harness** — with prompt-cache-friendly context management, real streaming, and a local account panel. No external API keys, no dollar billing: everything stays on your own WorkBuddy credits.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin (official bundle format, installable with `dsh plugin add`).

## How it works

```
DSH ──► local bridge (this plugin, OpenAI-compatible)
          │
          ├─ wbipc mode:  asks the locally running WorkBuddy desktop app to
          │               send the request; the app attaches its own token.
          │               Nothing is stored on disk. (default)
          │
          └─ direct mode: this plugin holds its own OAuth device-flow token
                          (the same flow the official CLI uses) and streams
                          from the backend directly.
                          ▼
               WorkBuddy backend (credit billing, server-side prompt cache)
```

Both transports bill your WorkBuddy credits. The bridge never talks to any
third-party API.

## Features

- **Two transports** — `wbipc` (zero credential storage, needs the desktop
  app running) and `direct` (real token-by-token streaming, no size/time
  caps, works without the desktop app). Switch at runtime from the panel,
  via `POST /config/mode`, or by asking the agent ("切到 direct 模式") —
  no restart needed.
- **In-DSH settings panel** — once installed as a bundle, DSH's Settings
  gains a **WorkBuddy 桥接** section: current account and credential expiry,
  credit balance, WeChat QR login / add account, saved-account switching,
  runtime transport toggle, today's spend vs budget, and the live price
  table. A browser fallback panel is also served at
  `http://127.0.0.1:37321/login/page` (useful before the bundle install).
- **DSH tool** — `workbuddy_account`, callable by the agent to list / switch
  accounts, check balance, read live prices or switch transport ("切到 direct
  模式", "查下积分"). Verified end-to-end in a live session.
- **Daily credit budget** — refuse requests once the configured daily spend
  is reached (`dailyCreditBudget`, 0 = unlimited).
- **Local-only by design** — the endpoint binds to `127.0.0.1`, rejects
  cross-site browser requests and DNS-rebinding hosts, and requires a
  generated auth token. Conversation content is **not** logged by default.
- **Cache-aware** — DSH keeps prompt prefixes stable between turns, so the
  backend's prompt cache hits (measured in practice: ~70% input savings from
  the third turn on).

## Install

Prerequisites: DeepSeek Harness (desktop or `dsh` CLI) and a WorkBuddy
account.

```sh
dsh plugin --profile <your-profile> add <path-to-this-repo>
```

Then make sure the provider credential exists — the bridge checks the value
of `WORKBUDDY_PROXY_KEY` against its own `authToken`:

```sh
dsh credentials set WORKBUDDY_PROXY_KEY <authToken printed on first start>
```

(The token is auto-generated into `config.json` next to `index.js` on first
start.)

### Manual install (without the bundle mechanism)

Copy `index.js`, `cordis.patch.yml` and `config.example.json` into
`~/.dsh/plugins/workbuddy-bridge/`, add an insert entry referencing the
absolute path in your profile's `cordis.patch.yml`, and restart DeepSeek
Harness.

## First chat

1. Start DeepSeek Harness. The bridge listens on `127.0.0.1:37321`.
2. Pick a model in the **WorkBuddy (credits)** group.
3. `wbipc` mode: keep the WorkBuddy desktop app running and logged in.
   `direct` mode: open `http://127.0.0.1:37321/login/page` and scan the QR
   once. Set `"mode": "direct"` in `config.json` and restart Harness.

## Configuration

All keys are read from `config.json` next to `index.js` (see
[config.example.json](config.example.json)):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `wbipc` | `wbipc` or `direct`; switchable at runtime (panel / `POST /config/mode` / agent tool) |
| `realm` | `cn` | `cn` (copilot.tencent.com) or `global` (workbuddy.ai) |
| `port` | `37321` | Local endpoint port |
| `authToken` | auto-generated | Shared secret; must match `WORKBUDDY_PROXY_KEY` |
| `dailyCreditBudget` | `3000` | Daily credit spend limit, `0` = unlimited |
| `perRequestCreditBudget` | `1000` | Estimated single-request cap (runaway guard), `0` = off |
| `logRequests` | `true` | Metadata log (model, tokens, cache hits, credit) |
| `logBodies` | `false` | **Stores full conversation text in `logs/`** |
| `logRetentionDays` | `7` | Auto-delete older logs |
| `models` | 15 current models | Exposed model ids |

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: everything runs locally; the
only outbound traffic is model/auth/balance requests to the WorkBuddy
backend itself. No telemetry, no conversation logging by default, tokens
stay on disk with owner-only permissions.

## Security

See [SECURITY.md](SECURITY.md).

## Risks and disclaimer

This bridge uses WorkBuddy endpoints in ways the official clients do not.
Depending on the platform's terms of service this may put your account at
risk. Use your own account, at your own scale, and understand that you bear
the consequences. This project is not affiliated with Tencent or DeepSeek.

## License

[MIT with an additional no-commercial-resale clause](LICENSE) — selling API
access, pooling accounts, or bundling this into paid relay services is
explicitly not authorized.
