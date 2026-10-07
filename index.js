// dsh-workbuddy-bridge — use WorkBuddy credit-billed models inside DeepSeek Harness.
//
// Two transports:
//   wbipc  — requests are forwarded by the locally running WorkBuddy desktop
//            app through its own IPC broker; the desktop app attaches the
//            Bearer token itself. No credentials are ever stored on disk.
//   direct — this plugin obtains its own OAuth device-authorization tokens
//            from the WorkBuddy backend (the same flow the official CLI uses)
//            and talks to the backend directly with real streaming.
//
// Everything runs locally. No conversation content, credentials, or usage
// data leaves this machine except the model requests sent to the WorkBuddy
// backend itself.

import * as net from 'net'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { fileURLToPath, pathToFileURL } from 'url'

export const name = 'workbuddy-bridge'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.join(PLUGIN_DIR, 'logs')
const AUTH_FILE = path.join(PLUGIN_DIR, 'auth.json')
const AUTHS_DIR = path.join(PLUGIN_DIR, 'auths')
const STATE_FILE = path.join(PLUGIN_DIR, 'state.json')
const CONFIG_FILE = path.join(PLUGIN_DIR, 'config.json')

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mode: 'wbipc', // 'wbipc' | 'direct'
  realm: 'cn', // 'cn' | 'global'
  port: 37321,
  authToken: '', // empty = generated on first start and persisted here
  dailyCreditBudget: 50, // credits/day, 0 = unlimited
  logRequests: true,
  logBodies: false, // WARNING: true stores full conversation text on disk
  logRetentionDays: 7,
  clientVersion: '5.5.4', // WorkBuddy desktop version segment for UA
  cliVersion: '2.137.1', // CLI version segment for UA
  models: [
    'hy4-preview', 'hy3', 'space-bunny', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'
  ],
}

function loadConfig() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { /* first run */ }
  const cfg = { ...DEFAULTS, ...user }
  if (!cfg.authToken) {
    // generate once so the local endpoint is never unauthenticated
    cfg.authToken = crypto.randomBytes(24).toString('base64url')
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    } catch { /* keep running with in-memory token */ }
  }
  return cfg
}

const CONFIG = loadConfig()

function setMode(mode) {
  if (mode !== 'wbipc' && mode !== 'direct') return false
  CONFIG.mode = mode
  try {
    const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    disk.mode = mode
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(disk, null, 2), { mode: 0o600 })
  } catch { /* in-memory switch still applies */ }
  appendLog({ ts: new Date().toISOString(), event: 'mode_switch', mode })
  return true
}

const REALMS = {
  cn: {
    chatBase: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    origin: 'https://www.codebuddy.cn',
    acceptLanguage: 'zh-CN',
    uaPlatform: 'WorkBuddy',
  },
  global: {
    chatBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    acceptLanguage: 'en-US',
    uaPlatform: 'WorkBuddy AI',
  },
}

function realm() { return REALMS[CONFIG.realm] ?? REALMS.cn }

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function todayLogPath() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return path.join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`)
}

function appendLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(todayLogPath(), JSON.stringify(entry) + '\n')
  } catch { /* logging must never break the proxy */ }
}

function cleanOldLogs() {
  if (!(CONFIG.logRetentionDays > 0)) return
  try {
    const cutoff = Date.now() - CONFIG.logRetentionDays * 86400_000
    for (const f of fs.readdirSync(LOG_DIR)) {
      const p = path.join(LOG_DIR, f)
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// daily credit budget
// ---------------------------------------------------------------------------

let spend = { date: '', credits: 0 }

function loadSpend() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (s?.date === new Date().toISOString().slice(0, 10)) spend = s
  } catch { /* first run */ }
}

function addSpend(credit) {
  const today = new Date().toISOString().slice(0, 10)
  if (spend.date !== today) spend = { date: today, credits: 0 }
  spend.credits += credit || 0
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(spend), { mode: 0o600 }) } catch { /* ignore */ }
}

function budgetBlocked() {
  if (!(CONFIG.dailyCreditBudget > 0)) return false
  loadSpend()
  return spend.date === new Date().toISOString().slice(0, 10) && spend.credits >= CONFIG.dailyCreditBudget
}

// ---------------------------------------------------------------------------
// auth store (direct mode): plaintext tokens, restricted file permissions
// ---------------------------------------------------------------------------

function loadAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
    return a?.accessToken ? a : null
  } catch { return null }
}

function saveAuth(a) {
  a.updatedAt = new Date().toISOString()
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 })
  try { fs.chmodSync(AUTH_FILE, 0o600) } catch { /* best effort on win32 */ }
  if (a.uid) {
    try {
      fs.mkdirSync(AUTHS_DIR, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(AUTHS_DIR, `${a.uid}.json`), JSON.stringify(a, null, 2), { mode: 0o600 })
    } catch { /* best effort */ }
  }
}

function listAuths() {
  try {
    return fs.readdirSync(AUTHS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(AUTHS_DIR, f), 'utf8'))
        return { uid: a.uid ?? f.replace(/\.json$/, ''), nickname: a.nickname, updatedAt: a.updatedAt }
      } catch { return { uid: f.replace(/\.json$/, '') } }
    })
  } catch { return [] }
}

function switchAuth(uid) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(AUTHS_DIR, `${uid}.json`), 'utf8'))
    if (!a?.accessToken) return null
    saveAuth(a)
    return a
  } catch { return null }
}

// ---------------------------------------------------------------------------
// header builders (mirrors the official client's outbound header families)
// ---------------------------------------------------------------------------

function threeSegmentUA() {
  const r = realm()
  return `WorkBuddy/${CONFIG.clientVersion} ${r.uaPlatform}/${CONFIG.clientVersion} CLI/${CONFIG.cliVersion}`
}

function hex36(seed) {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 36)
}

function msgId() { return crypto.randomUUID().replace(/-/g, '') }

function loginHeaders() {
  const r = realm()
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    origin: r.origin,
    referer: r.origin + '/',
    'user-agent': `CLI/${CONFIG.cliVersion} CodeBuddy/${CONFIG.cliVersion}`,
    'x-codebuddy-request': '1',
    'accept-language': r.acceptLanguage,
  }
}

function stableHeaders(uid) {
  return {
    'x-machine-id': hex36(`wb2a:machine:${uid}`),
    'x-session-id': hex36(`wb2a:session:${uid}`),
  }
}

function chatHeaders(a, convReqId) {
  const r = realm()
  const messageId = msgId()
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-requested-with': 'XMLHttpRequest',
    origin: r.origin,
    referer: r.origin + '/',
    'user-agent': threeSegmentUA(),
    'x-codebuddy-request': '1',
    'accept-language': r.acceptLanguage,
    authorization: `Bearer ${a.accessToken}`,
    'x-agent-purpose': 'conversation',
    'x-ide-name': 'WorkBuddy',
    'x-ide-type': 'WorkBuddy',
    'x-ide-version': CONFIG.clientVersion,
    'x-product': 'WorkBuddy',
    'x-conversation-request-id': convReqId,
    'x-conversation-message-id': messageId,
    'x-request-id': messageId,
    'x-root-request-id': convReqId,
    'x-trace-id': convReqId,
    'x-b3-traceid': convReqId,
    'x-b3-spanid': messageId.slice(0, 16),
    'x-b3-sampled': '1',
  }
  if (a.uid) h['x-user-id'] = a.uid; else h['x-no-user-id'] = '1'
  if (a.enterpriseId) h['x-enterprise-id'] = a.enterpriseId
  else h['x-no-enterprise-id'] = '1'
  if (a.domain) h['x-domain'] = a.domain
  else h['x-no-department-info'] = '1'
  if (a.uid) Object.assign(h, stableHeaders(a.uid))
  return h
}

function billingHeaders(a) {
  const r = realm()
  const h = {
    authorization: `Bearer ${a.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'accept-language': r.acceptLanguage,
    'user-agent': `WorkBuddy/${CONFIG.clientVersion}`,
  }
  if (a.uid) h['x-user-id'] = a.uid
  if (a.enterpriseId) { h['x-enterprise-id'] = a.enterpriseId; h['x-tenant-id'] = a.enterpriseId }
  if (a.domain) h['x-domain'] = a.domain
  return h
}

let pendingLogin = null // { state, startedAt }

// ---------------------------------------------------------------------------
// catalog + promotions: effective price per model (Asia/Shanghai windows)
// ---------------------------------------------------------------------------

const CATALOG_FILE = path.join(PLUGIN_DIR, 'catalog.json')
const SH_OFFSET_MS = 8 * 3600_000 // Asia/Shanghai has no DST

let catalog = { models: {}, promos: {}, fetchedAt: null }
try { catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) } catch { /* first run */ }

async function fetchCatalog() {
  const a = loadAuth()
  if (!a) return // pricing needs direct-mode credentials
  const r = realm()
  const host = new URL(r.chatBase).host
  const headers = (ua) => ({
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    authorization: `Bearer ${a.accessToken}`,
    'x-user-id': a.uid ?? '',
    'x-domain': host,
    'x-product': 'SaaS',
    'user-agent': ua,
    'x-codebuddy-request': '1',
    'accept-language': r.acceptLanguage,
  })
  const out = { models: { ...catalog.models }, promos: { ...catalog.promos }, fetchedAt: catalog.fetchedAt }
  const sources = [
    [`CLI/${CONFIG.cliVersion} CodeBuddy/${CONFIG.cliVersion}`, false],
    ['CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0', true], // promotions ship with the IDE UA only
  ]
  for (const [ua, wantPromos] of sources) {
    try {
      const res = await fetch(`${r.chatBase}/v3/config`, { headers: headers(ua) })
      const env = await res.json().catch(() => null)
      const data = env?.data
      if (!data) continue
      for (const m of data.models ?? []) out.models[m.id] = m
      if (wantPromos) {
        out.promos = {}
        for (const p of data.modelPromotions ?? []) {
          if (!p.enabled) continue
          for (const mid of p.modelIds ?? []) (out.promos[mid] ??= []).push(p)
        }
      }
    } catch { /* keep previous catalog */ }
  }
  out.fetchedAt = new Date().toISOString()
  catalog = out
  try { fs.writeFileSync(CATALOG_FILE, JSON.stringify(out)) } catch { /* ignore */ }
}

function nowSH() { return new Date(Date.now() + SH_OFFSET_MS) } // read with UTC getters

function inDailyWindow(dSH, daily) {
  if (!daily?.length) return true
  const minutes = dSH.getUTCHours() * 60 + dSH.getUTCMinutes()
  return daily.some((w) => {
    const [sh, sm] = String(w.start ?? '').split(':').map(Number)
    const [eh, em] = String(w.end ?? '').split(':').map(Number)
    if (Number.isNaN(sh) || Number.isNaN(eh)) return true
    const s = sh * 60 + (sm || 0)
    const e = eh * 60 + (em || 0)
    // overnight window (e.g. 23:00 -> 7:50) wraps around midnight
    return s <= e ? minutes >= s && minutes <= e : minutes >= s || minutes <= e
  })
}

function parseMult(credits) {
  const m = /x([\d.]+)/.exec(credits || '')
  return m ? parseFloat(m[1]) : null
}

function promoActive(p) {
  if (!p?.enabled) return false
  const nowMs = Date.now()
  if (p.schedule?.validFrom && nowMs < Date.parse(p.schedule.validFrom)) return false
  if (p.schedule?.validUntil && nowMs > Date.parse(p.schedule.validUntil)) return false
  return inDailyWindow(nowSH(), p.schedule?.daily)
}

function windowNote(p) {
  const daily = p?.schedule?.daily ?? []
  return daily.map((w) => `${w.start}-${w.end}`).join('/')
}

// effective multiplier for a model right now:
//   { base, effective, free, label, note, exhausted }
function effectivePrice(mid) {
  const m = catalog.models[mid]
  const base = parseMult(m?.credits)
  if (!m || base === null) return null
  const dSH = nowSH()
  let best = null
  for (const p of catalog.promos[mid] ?? []) {
    if (!promoActive(p)) continue
    if (!best || (p.priority ?? 0) > (best.priority ?? 0)) best = p
  }
  loadSpend()
  const exhausted = freeExhausted[mid]
  if (best?.discount && !exhausted) {
    const f = best.discount.factor
    const note = windowNote(best)
    if (f === 0) return { base, effective: 0, free: true, label: best.badge?.label ?? '限时免费', note }
    if (typeof f === 'number') {
      return { base, effective: Math.round(base * f * 100) / 100, free: false, label: best.badge?.label ?? '', note }
    }
  }
  // badge-only promo (no discount factor): price is unchanged; surface the
  // vendor's own explanation (e.g. peak-hour surcharge windows)
  const hover = best?.hover?.textZh ?? ''
  return { base, effective: base, free: false, label: best?.badge?.label ?? '', note: hover || windowNote(best), exhausted: !!exhausted }
}

// pricing snapshot for panel/tool
function pricingList() {
  return Object.keys(catalog.models)
    .filter((mid) => !/^(codewise-|nes-gf|hunyuan-image)/.test(mid) && !['default', 'auto'].includes(mid))
    .map((mid) => {
      const m = catalog.models[mid]
      const ep = effectivePrice(mid)
      return {
        id: mid,
        name: m.name || mid,
        base: ep?.base ?? parseMult(m.credits),
        effective: ep?.effective ?? null,
        free: !!ep?.free,
        label: ep?.label ?? '',
        note: ep?.note ?? '',
        exhausted: !!ep?.exhausted,
      }
    })
    .filter((x) => x.base !== null)
    .sort((a, b) => (a.effective ?? 9) - (b.effective ?? 9))
}

// free-quota exhaustion: a model whose promo price is 0 but that returned
// credit > 0 has used up its daily free allowance — record for today.
let freeExhausted = {}
function loadFreeExhausted() {
  loadSpend() // ensures spend.date is today
  if (freeExhausted.__date !== spend.date) {
    freeExhausted = { __date: spend.date }
  }
}

function markFreeExhaustedIfNeeded(modelId, credit) {
  if (!credit) return
  const ep = effectivePrice(modelId)
  if (ep?.free) {
    loadFreeExhausted()
    freeExhausted[modelId] = true
    appendLog({ ts: new Date().toISOString(), event: 'free_quota_exhausted', model: modelId })
  }
}

// ---------------------------------------------------------------------------
// direct client: refresh + streaming chat + balance
// ---------------------------------------------------------------------------

class DirectClient {
  constructor() { this.refreshing = null }

  async refreshForce(a) {
    const r = realm()
    const res = await fetch(`${r.chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        ...loginHeaders(),
        'user-agent': threeSegmentUA(),
        'x-refresh-token': a.refreshToken,
        'x-auth-refresh-source': 'plugin',
        ...(a.enterpriseId ? { 'x-enterprise-id': a.enterpriseId } : {}),
        ...(a.uid ? stableHeaders(a.uid) : {}),
      },
      body: '{}',
    })
    const env = await res.json().catch(() => null)
    if (!res.ok || !env?.data?.accessToken) {
      throw Object.assign(new Error(`token refresh failed (HTTP ${res.status}) — re-login required`), { needsRelogin: true })
    }
    a.accessToken = env.data.accessToken
    if (env.data.refreshToken) a.refreshToken = env.data.refreshToken
    if (env.data.expiresIn) a.expiresAt = Date.now() + env.data.expiresIn * 1000
    saveAuth(a)
    appendLog({ ts: new Date().toISOString(), event: 'token_refreshed', uid: a.uid })
  }

  async ensureToken() {
    const a = loadAuth()
    if (!a) throw Object.assign(new Error('direct mode is not logged in'), { needsLogin: true })
    if (a.expiresAt && a.expiresAt - Date.now() < 10 * 60 * 1000 && a.refreshToken) {
      this.refreshing ??= this.refreshForce(a).finally(() => { this.refreshing = null })
      await this.refreshing
    }
    return a
  }

  async chat(payloadStr, res, req, logCtx) {
    const t0 = Date.now()
    let a = await this.ensureToken()
    const convReqId = msgId()
    const ac = new AbortController()
    req.on('close', () => ac.abort(new Error('client disconnected')))

    let upstream = await this.send(a, payloadStr, convReqId, ac.signal)
    if (upstream.status === 401 && a.refreshToken) {
      appendLog({ ts: new Date().toISOString(), event: 'token_401_retry', uid: a.uid })
      await this.refreshForce(a)
      a = loadAuth()
      upstream = await this.send(a, payloadStr, convReqId, ac.signal)
    }

    const isSse = (upstream.headers.get('content-type') ?? '').includes('event-stream')
    if (isSse) {
      res.writeHead(upstream.status, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
    } else {
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    }

    const usage = { prompt: null, cacheHit: 0, cacheMiss: 0, credit: 0 }
    const decoder = new TextDecoder()
    let lineBuf = ''
    const reader = upstream.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (isSse) {
          lineBuf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, idx)
            lineBuf = lineBuf.slice(idx + 1)
            if (line.includes('"credit"')) {
              try {
                const obj = JSON.parse(line.startsWith('data: ') ? line.slice(6) : line)
                if (obj.usage) {
                  usage.prompt = obj.usage.prompt_tokens
                  usage.cacheHit = obj.usage.prompt_cache_hit_tokens ?? 0
                  usage.cacheMiss = obj.usage.prompt_cache_miss_tokens ?? 0
                  usage.credit = obj.usage.credit ?? 0
                }
              } catch { /* partial line */ }
            }
          }
        }
        if (!res.writableEnded) res.write(Buffer.from(value))
      }
      res.end()
    } finally {
      reader.releaseLock().catch?.(() => {})
    }
    addSpend(usage.credit)
    markFreeExhaustedIfNeeded(JSON.parse(payloadStr).model, usage.credit)
    appendLog({
      ts: new Date().toISOString(), event: 'request', mode: 'direct', ...logCtx,
      status: upstream.status, model: JSON.parse(payloadStr).model, durationMs: Date.now() - t0,
      usage: usage.prompt !== null ? {
        prompt_tokens: usage.prompt, prompt_cache_hit_tokens: usage.cacheHit,
        prompt_cache_miss_tokens: usage.cacheMiss, credit: usage.credit,
      } : null,
    })
  }

  send(a, payloadStr, convReqId, signal) {
    return fetch(`${realm().chatBase}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(a, convReqId),
      body: payloadStr,
      signal,
    })
  }

  async balance() {
    const a = await this.ensureToken()
    const r = realm()
    const layout = (d) => {
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    const end = new Date(Date.now() + 365 * 101 * 86400_000)
    const res = await fetch(`${r.billingBase}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(a),
      body: JSON.stringify({
        PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
        PackageEndTimeRangeBegin: layout(new Date()),
        PackageEndTimeRangeEnd: layout(end),
      }),
    })
    const env = await res.json().catch(() => null)
    const accounts = env?.Response?.Data?.Accounts
      ?? env?.response?.data?.accounts
      ?? env?.data?.Response?.Data?.Accounts
      ?? []
    let remain = 0
    let total = 0
    for (const p of accounts) {
      let pr = p.CycleCapacitySize > 0 ? p.CycleCapacityRemain : p.CapacityRemain
      let size = p.CycleCapacitySize > 0 ? p.CycleCapacitySize : p.CapacitySize
      if (pr < 0) pr = 0
      if (size < pr) size = pr
      remain += pr
      total += size
    }
    return { remain, total, packages: accounts.length }
  }
}

// ---------------------------------------------------------------------------
// wbipc client (default mode): forwards requests through the locally running
// WorkBuddy desktop app, which attaches the Bearer token itself.
// ---------------------------------------------------------------------------

function wbipcEndpointFile() {
  const dir = process.env.WORKBUDDY_CONFIG_DIR
    || process.env.CODEBUDDY_CONFIG_DIR
    || path.join(os.homedir(), '.workbuddy')
  return path.join(dir, 'wbipc', 'endpoint.json')
}

function readEndpoint() {
  const info = JSON.parse(fs.readFileSync(wbipcEndpointFile(), 'utf8'))
  if (!info?.endpoint || !info?.ticket) throw new Error('endpoint.json missing endpoint/ticket')
  return info
}

function ticketIdOf(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16)
}

function transcriptBuffer(side, t) {
  const parts = [side, String(t.protocol), t.endpoint, t.clientNonce, t.serverNonce]
  const chunks = []
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length, 0)
    chunks.push(len, b)
  }
  return Buffer.concat(chunks)
}

function hmacProof(key, side, t) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(transcriptBuffer(side, t))
    .digest('base64url')
}

class WbipcClient {
  constructor() {
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.rpcId = 0
    this.pending = new Map()
    this.connectPromise = null
    this.ready = false
    this.channel = ''
    this.clientNonce = ''
    this.helloDone = null
    this.helloFail = null
  }

  async ensure() {
    if (this.ready && this.socket && !this.socket.destroyed) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connect().finally(() => { this.connectPromise = null })
    return this.connectPromise
  }

  async connect() {
    const info = readEndpoint()
    await new Promise((resolve, reject) => {
      const sock = net.connect({ path: info.endpoint })
      sock.once('error', (e) => { sock.destroy(); reject(new Error(`wbipc connect failed: ${e.message}`)) })
      sock.once('connect', () => resolve())
      this.attach(sock, info)
    })
    await this.handshake(info)
    const res = await this.call('broker/GetPipe', { pipe: 'wb.request' })
    this.channel = res.channel
    this.ready = true
  }

  attach(sock, info) {
    this.socket = sock
    this.buffer = Buffer.alloc(0)
    sock.setNoDelay(true)
    sock.on('data', (d) => {
      this.buffer = this.buffer.length === 0 ? d : Buffer.concat([this.buffer, d])
      for (;;) {
        const idx = this.buffer.indexOf(10)
        if (idx < 0) return
        const line = this.buffer.subarray(0, idx)
        this.buffer = this.buffer.subarray(idx + 1)
        if (line.length === 0) continue
        let frame
        try { frame = JSON.parse(line.toString('utf8')) } catch { this.drop(); return }
        this.onFrame(frame, info)
      }
    })
    sock.on('error', () => this.drop())
    sock.on('close', () => this.drop())
  }

  drop() {
    this.ready = false
    this.channel = ''
    if (this.socket) { this.socket.destroy(); this.socket = null }
    const err = new Error('wbipc connection closed')
    this.helloFail?.(err)
    this.helloDone = null
    this.helloFail = null
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  send(obj) {
    if (!this.socket || this.socket.destroyed) throw new Error('wbipc not connected')
    this.socket.write(JSON.stringify(obj) + '\n')
  }

  onFrame(frame, info) {
    if (frame.type === 'session_challenge') {
      const t = { protocol: 1, endpoint: info.endpoint, clientNonce: this.clientNonce, serverNonce: frame.server_nonce }
      this.send({ type: 'session_prove', client_proof: hmacProof(info.ticket, 'wbipc-c', t) })
      return
    }
    if (frame.type === 'session_hello_error') {
      this.helloFail?.(new Error(`wbipc hello rejected: ${frame.code}`))
      this.helloDone = null
      this.helloFail = null
      this.drop()
      return
    }
    if (frame.type === 'session_hello_ack') {
      this.helloDone?.()
      this.helloDone = null
      this.helloFail = null
      return
    }
    if (frame.jsonrpc === '2.0' && frame.id !== undefined) {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.error) p.reject(Object.assign(new Error(frame.error.message || 'wbipc rpc error'), { code: frame.error.code }))
      else p.resolve(frame.result)
    }
  }

  handshake(info) {
    this.clientNonce = crypto.randomBytes(32).toString('base64url')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloDone = null
        this.helloFail = null
        reject(new Error('wbipc handshake timeout'))
      }, 5000)
      this.helloDone = () => { clearTimeout(timer); resolve() }
      this.helloFail = (e) => { clearTimeout(timer); reject(e) }
      try {
        this.send({
          type: 'session_hello',
          protocol_min: 1,
          protocol_max: 1,
          client_nonce: this.clientNonce,
          ticket_id: ticketIdOf(info.ticket),
          client: { kind: 'dsh-plugin', id: 'workbuddy-bridge', version: '1.0.0' },
        })
      } catch (e) {
        clearTimeout(timer)
        this.helloDone = null
        this.helloFail = null
        reject(e)
      }
    })
  }

  call(method, params, mode = 'call') {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId
      this.pending.set(id, { resolve, reject })
      try {
        this.send({ jsonrpc: '2.0', id, method, params, mode })
      } catch (e) { this.pending.delete(id); reject(e) }
    })
  }

  async httpFetch(opts) {
    await this.ensure()
    const params = { method: opts.method, path: opts.path }
    if (opts.headers) params.headers = opts.headers
    if (opts.body) params.body_b64 = opts.body.toString('base64')
    const res = await this.call(`${this.channel}/http.fetch`, params)
    return { status: res.status, headers: res.headers, body: Buffer.from(res.body_b64, 'base64') }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function msgChars(messages) {
  let n = 0
  for (const m of messages ?? []) n += typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length
  return n
}

function prefixHashes(messages) {
  const out = []
  const h = crypto.createHash('sha256')
  for (const m of messages ?? []) {
    h.update(JSON.stringify(m))
    out.push(h.copy().digest('hex').slice(0, 12))
  }
  return out
}

function usageSummary(u) {
  if (!u) return null
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? undefined,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens,
    credit: u.credit,
  }
}

function parseSse(body) {
  const chunks = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6).trim()
    if (!data || data === '[DONE]') continue
    try { chunks.push(JSON.parse(data)) } catch { /* skip */ }
  }
  const usage = chunks.filter((c) => c.usage).map((c) => c.usage).pop() ?? null
  return { chunks, usage }
}

function foldSseToCompletion(chunks, usage, model) {
  const contentParts = []
  const reasoningParts = []
  const toolCalls = []
  let finishReason = null
  let id
  for (const c of chunks) {
    id ??= c.id
    const ch = c.choices?.[0]
    if (!ch) continue
    if (ch.delta?.content) contentParts.push(ch.delta.content)
    if (ch.delta?.reasoning_content) reasoningParts.push(ch.delta.reasoning_content)
    if (ch.delta?.tool_calls) toolCalls.push(...ch.delta.tool_calls)
    if (ch.finish_reason) finishReason = ch.finish_reason
  }
  const message = { role: 'assistant', content: contentParts.join('') }
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join('')
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: id ?? 'chatcmpl-proxy',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
    usage,
  }
}

function collectImageBytes(messages) {
  let n = 0
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue
    for (const part of m.content) {
      if (part?.type === 'image_url') n += String(part.image_url?.url ?? '').length
      else if (part?.type === 'image') n += String(part.data ?? part.image?.data ?? '').length
    }
  }
  return n
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// local panel page (served by the same server; same-origin fetches only)
// ---------------------------------------------------------------------------

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>WorkBuddy Bridge - account panel</title>
<style>
  body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#111;color:#eee;max-width:560px;margin:40px auto;padding:0 16px}
  h1{font-size:20px} .card{background:#1c1c1e;border-radius:12px;padding:16px 20px;margin:12px 0}
  button{background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}
  button.ghost{background:#333} button:disabled{opacity:.5;cursor:default}
  .row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #2a2a2a;gap:8px}
  .row:last-child{border-bottom:0}
  .muted{color:#888;font-size:13px} .ok{color:#4cd964} .cur{color:#2f6fed;font-weight:600}
  .mode-btn.active{background:#2f6fed}
  a{color:#7fb0ff;word-break:break-all}
  #msg{margin-top:10px;min-height:22px}
</style></head><body>
<h1>WorkBuddy Bridge · 扫码切号 / 余额</h1>
<div class="card">
  <div class="row"><span>当前账号</span><span id="cur" class="muted">…</span></div>
  <div class="row"><span>传输模式</span><span><button class="ghost mode-btn" id="m-wbipc" data-mode="wbipc">wbipc（桌面端代持）</button> <button class="ghost mode-btn" id="m-direct" data-mode="direct">direct（直连流式）</button></span></div>
  <div class="row"><span>今日已耗积分</span><span id="spend" class="muted">…</span></div>
  <div class="row"><span>账户余额</span><span id="bal" class="muted">…</span> <button class="ghost" id="balbtn">查询</button></div>
  <button id="start">开始新登录（扫码）</button>
  <div id="msg" class="muted"></div>
</div>
<div class="card"><h1 style="font-size:16px;margin-top:0">实时价格（每小时自动更新）</h1><div id="pricing" class="muted">加载中…</div></div>
<div class="card"><h1 style="font-size:16px;margin-top:0">已保存账号</h1><div id="accounts" class="muted">加载中…</div></div>
<script>
const $ = (id) => document.getElementById(id)
async function loadStatus() {
  const d = await (await fetch('/status')).json()
  $('cur').textContent = d.current ? (d.current.nickname || d.current.uid.slice(0, 8)) : '未登录'
  $('spend').textContent = d.spendToday + ' / ' + (d.dailyCreditBudget > 0 ? d.dailyCreditBudget : '∞')
  for (const b of document.querySelectorAll('.mode-btn')) b.classList.toggle('active', b.dataset.mode === d.mode)
}
for (const b of document.querySelectorAll('.mode-btn')) {
  b.onclick = async () => {
    const r = await fetch('/config/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: b.dataset.mode }) })
    const d = await r.json()
    $('msg').textContent = d.ok ? ('已切换到 ' + d.mode + (d.warnings?.length ? '：' + d.warnings.join('；') : '')) : (d.error?.message || '切换失败')
    loadStatus()
  }
}
async function loadAccounts() {
  const d = await (await fetch('/auth')).json()
  $('accounts').innerHTML = ''
  if (!d.accounts.length) { $('accounts').textContent = '（还没有保存的账号）'; return }
  for (const a of d.accounts) {
    const div = document.createElement('div'); div.className = 'row'
    const label = document.createElement('span')
    const isCur = d.current && d.current.uid === a.uid
    if (isCur) { const t = document.createElement('span'); t.className = 'cur'; t.textContent = '● 当前 '; label.appendChild(t) }
    label.appendChild(document.createTextNode(a.nickname || a.uid.slice(0, 8)))
    if (a.updatedAt) { const m = document.createElement('span'); m.className = 'muted'; m.textContent = ' ' + a.updatedAt.slice(0, 10); label.appendChild(m) }
    div.appendChild(label)
    if (!isCur) {
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '切到这个'
      b.onclick = async () => {
        const r2 = await fetch('/auth/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: a.uid }) })
        const d2 = await r2.json()
        $('msg').textContent = d2.ok ? '已切换到 ' + (d2.nickname || d2.uid) : (d2.error?.message || '切换失败')
        loadStatus(); loadAccounts()
      }      div.appendChild(b)
    }
    $('accounts').appendChild(div)
  }
}
async function loadPricing() {
  const d = await (await fetch('/pricing')).json()
  const el = $('pricing')
  el.innerHTML = ''
  if (!d.models?.length) { el.textContent = '暂无数据（直连模式登录后自动获取）'; return }
  for (const x of d.models) {
    const row = document.createElement('div'); row.className = 'row'
    const left = document.createElement('span'); left.textContent = x.name + ' [' + x.id + ']'
    const right = document.createElement('span')
    if (x.free && !x.exhausted) {
      right.className = 'ok'; right.textContent = '现在免费' + (x.note ? '（' + x.note + '）' : '')
    } else {
      let t = 'x' + x.effective
      if (x.effective !== x.base) t += ' · 原x' + x.base
      if (x.label) t += ' · ' + x.label
      if (x.note) t += '（' + x.note + '）'
      if (x.exhausted) t += ' · 今日免费额度已用完'
      right.textContent = t
      if (x.effective < x.base) right.className = 'ok'
    }
    row.appendChild(left); row.appendChild(right)
    el.appendChild(row)
  }
}
$('balbtn').onclick = async () => {
  $('bal').textContent = '查询中…'
  try {
    const d = await (await fetch('/balance')).json()
    $('bal').textContent = d.error ? d.error.message : (d.remain + ' / ' + d.total + '（' + d.packages + ' 个套餐）')
  } catch (e) { $('bal').textContent = '查询失败' }
}
$('start').onclick = async () => {
  $('start').disabled = true
  $('msg').textContent = '正在向上游申请授权链接…'
  try {
    const d = await (await fetch('/login', { method: 'POST' })).json()
    if (!d.authUrl) { $('msg').textContent = '获取授权链接失败：' + JSON.stringify(d); $('start').disabled = false; return }
    $('msg').textContent = '1. 在新打开的页面用微信扫码确认（若被拦截请手动打开授权链接）  2. 等待自动检测…'
    const link = document.createElement('a')
    link.href = d.authUrl
    link.target = '_blank'
    link.textContent = d.authUrl
    $('msg').appendChild(document.createElement('br'))
    $('msg').appendChild(link)
    window.open(d.authUrl, '_blank')
    const deadline = Date.now() + 10 * 60 * 1000
    const timer = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(timer); $('msg').textContent = '超时，请重新开始'; $('start').disabled = false; return }
      const pd = await (await fetch('/login/poll')).json()
      if (pd.status === 'ok') {
        clearInterval(timer)
        $('msg').textContent = '登录成功：' + (pd.nickname || pd.uid) + '（token 已保存，立即生效，无需重启）'
        $('start').disabled = false
        loadStatus(); loadAccounts()
      }
    }, 3000)
  } catch (e) { $('msg').textContent = '失败：' + e; $('start').disabled = false }
}
loadStatus(); loadAccounts(); loadPricing()
setInterval(loadPricing, 60_000)
</script></body></html>`

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  cleanOldLogs()
  loadSpend()

  const wbipc = new WbipcClient()
  const direct = new DirectClient()

  // DSH tool integration: lets the agent answer "切换账号 / 查余额" in chat.
  // Registered only when the dsh-tools package is resolvable (always true for
  // bundle installs; loose-directory installs fall back to the profile's
  // node_modules).
  registerTools(ctx).catch(() => { /* tools are optional */ })

  // refresh the model catalog / promotions hourly and on startup
  const catalogTimer = setInterval(() => { fetchCatalog().catch(() => {}) }, 3600_000)
  catalogTimer.unref?.()
  fetchCatalog().catch(() => {})

  const server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? '').split('?')[0]

      // ---- transport security (this is a localhost service) ----
      // 1. Host must be loopback: blocks DNS-rebinding domains.
      const host = (req.headers.host ?? '').split(':')[0]
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'loopback only' } }))
        return
      }
      // 2. Browser cross-site requests are rejected: a malicious web page
      //    must not be able to spend credits by POSTing to localhost.
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'cross-site requests are not allowed' } }))
        return
      }
      // 3. All data endpoints require the shared token. Exemptions: /health
      //    (no secrets) and the static panel page. The panel's own fetches
      //    carry Sec-Fetch-Site: same-origin, which a web page cannot forge.
      const needsAuth = url !== '/health' && url !== '/login/page' && site !== 'same-origin'
      if (needsAuth) {
        const auth = req.headers.authorization ?? ''
        if (auth !== `Bearer ${CONFIG.authToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unauthorized: set Authorization: Bearer <authToken from config.json>' } }))
          return
        }
      }

      // ---- read-only info ----
      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        let wbipcOk = false
        try { readEndpoint(); wbipcOk = true } catch { /* desktop app not running */ }
        res.end(JSON.stringify({ plugin: name, ok: true, mode: CONFIG.mode, realm: CONFIG.realm, workbuddyIpc: wbipcOk }))
        return
      }

      if (req.method === 'GET' && url === '/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const a = loadAuth()
        loadSpend()
        res.end(JSON.stringify({
          mode: CONFIG.mode,
          realm: CONFIG.realm,
          current: a ? { uid: a.uid, nickname: a.nickname, expiresAt: a.expiresAt } : null,
          spendToday: Math.round((spend.credits ?? 0) * 1000) / 1000,
          dailyCreditBudget: CONFIG.dailyCreditBudget,
        }))
        return
      }

      if (req.method === 'GET' && url === '/pricing') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          fetchedAt: catalog.fetchedAt,
          models: pricingList(),
        }))
        return
      }

      if (req.method === 'GET' && url === '/balance') {
        try {
          const b = await direct.balance()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(b))
        } catch (e) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }))
        }
        return
      }

      // ---- device-authorization login ----
      if (req.method === 'POST' && url === '/login') {
        const r = await fetch(`${realm().chatBase}/v2/plugin/auth/state?platform=CLI`, {
          method: 'POST', headers: loginHeaders(), body: '{}',
        })
        const env = await r.json().catch(() => null)
        const state = env?.data?.state
        const authUrl = env?.data?.authUrl
        if (!state || !authUrl) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `auth/state failed: HTTP ${r.status}` } }))
          return
        }
        pendingLogin = { state, startedAt: Date.now() }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ state, authUrl }))
        return
      }

      if (req.method === 'GET' && url === '/login/poll') {
        if (!pendingLogin || Date.now() - pendingLogin.startedAt > 10 * 60 * 1000) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'no pending login (or expired); POST /login first' } }))
          return
        }
        const r = await fetch(`${realm().chatBase}/v2/plugin/auth/token?state=${pendingLogin.state}`, { headers: loginHeaders() })
        const env = await r.json().catch(() => null)
        const tok = env?.data
        if (!env || env.code !== 0 || !tok?.accessToken) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'pending' }))
          return
        }
        const a = {
          accessToken: tok.accessToken,
          refreshToken: tok.refreshToken ?? '',
          expiresAt: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : 0,
          domain: tok.domain,
        }
        try {
          const ar = await fetch(`${realm().chatBase}/v2/plugin/login/account?state=${pendingLogin.state}`, {
            headers: { ...loginHeaders(), authorization: `Bearer ${a.accessToken}` },
          })
          const aenv = await ar.json().catch(() => null)
          if (aenv?.data?.uid) {
            a.uid = aenv.data.uid
            a.enterpriseId = aenv.data.enterpriseId || undefined
            a.nickname = aenv.data.nickname
          }
        } catch { /* account info is optional */ }
        saveAuth(a)
        pendingLogin = null
        appendLog({ ts: new Date().toISOString(), event: 'login', uid: a.uid, nickname: a.nickname })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', uid: a.uid, nickname: a.nickname, expiresAt: a.expiresAt }))
        return
      }

      if (req.method === 'GET' && url === '/auth') {
        res.writeHead(200, { 'content-type': 'application/json' })
        const a = loadAuth()
        res.end(JSON.stringify({
          current: a ? { uid: a.uid, nickname: a.nickname, expiresAt: a.expiresAt } : null,
          accounts: listAuths(),
        }))
        return
      }

      if (req.method === 'POST' && url === '/auth/switch') {
        const body = await readBody(req)
        let uid = ''
        try { uid = String(JSON.parse(body.toString('utf8')).uid ?? '') } catch { /* invalid */ }
        const a = uid ? switchAuth(uid) : null
        if (!a) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `no saved account uid=${uid}` } }))
          return
        }
        appendLog({ ts: new Date().toISOString(), event: 'account_switch', uid: a.uid, nickname: a.nickname })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, uid: a.uid, nickname: a.nickname }))
        return
      }

      if (req.method === 'POST' && url === '/config/mode') {
        const body = await readBody(req)
        let mode = ''
        try { mode = String(JSON.parse(body.toString('utf8')).mode ?? '') } catch { /* invalid */ }
        if (mode !== 'wbipc' && mode !== 'direct') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'mode must be "wbipc" or "direct"' } }))
          return
        }
        const warnings = []
        if (mode === 'direct' && !loadAuth()) warnings.push('direct mode not logged in yet — use the panel QR login')
        if (mode === 'wbipc') {
          try { readEndpoint() } catch { warnings.push('WorkBuddy desktop app is not running — wbipc requests will fail with 502') }
          warnings.push('wbipc transport caps: ~768 KB request / 640 KB response; large contextWindow models may return 413')
        }
        setMode(mode)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, mode, warnings }))
        return
      }

      if (req.method === 'GET' && url === '/login/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(LOGIN_PAGE_HTML)
        return
      }

      if (req.method === 'GET' && /\/models$/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          object: 'list',
          data: CONFIG.models.map((id) => ({ id, object: 'model', owned_by: 'workbuddy' })),
        }))
        return
      }

      if (req.method !== 'POST' || !/\/chat\/completions$/.test(url)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url}` } }))
        return
      }

      const bodyBuf = await readBody(req)
      let body
      try { body = JSON.parse(bodyBuf.toString('utf8')) } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
        return
      }

      const logCtx = {
        msgCount: (body.messages ?? []).length, msgChars: msgChars(body.messages ?? []),
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        prefixTail: prefixHashes(body.messages ?? []).slice(-4),
      }
      const t0 = Date.now()

      if (budgetBlocked()) {
        appendLog({ ts: new Date().toISOString(), event: 'budget_blocked', model: body.model, spendToday: spend.credits })
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: `daily credit budget reached: ${spend.credits} >= ${CONFIG.dailyCreditBudget}`,
            hint: '提高 config.json 的 dailyCreditBudget（0 = 不限制）或明日再试',
          },
        }))
        return
      }

      // ---- direct mode: real streaming passthrough ----
      if (CONFIG.mode === 'direct') {
        const upstreamBody = { ...body, stream: true, stream_options: { include_usage: true } }
        try {
          await direct.chat(JSON.stringify(upstreamBody), res, req, logCtx)
        } catch (e) {
          if (!res.headersSent) {
            const status = e?.needsLogin ? 503 : 502
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              error: {
                message: String(e?.message ?? e),
                hint: e?.needsLogin
                  ? 'open the account panel: http://127.0.0.1:' + CONFIG.port + '/login/page'
                  : 'direct request failed',
              },
            }))
          } else {
            try { res.end() } catch { /* already closed */ }
          }
        }
        return
      }

      // ---- wbipc mode (default) ----
      const upstreamBody = { ...body, stream: true, stream_options: { include_usage: true } }
      const payload = Buffer.from(JSON.stringify(upstreamBody), 'utf8')

      // wbipc caps one JSON-RPC frame at 1 MiB and the body travels base64
      // encoded (4/3 expansion), so the payload must stay under ~768 KB.
      const FRAME_BUDGET = 768 * 1024
      if (payload.length > FRAME_BUDGET) {
        const imageBytes = collectImageBytes(body.messages)
        appendLog({
          ts: new Date().toISOString(), event: 'payload_too_large', model: body.model,
          payloadBytes: payload.length, imageBytes, msgCount: (body.messages ?? []).length,
        })
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: `payload ${payload.length} B exceeds the local WorkBuddy IPC limit (${FRAME_BUDGET} B)`,
            hint: imageBytes > 0
              ? `request carries ~${Math.round(imageBytes / 1024)} KB of images; shrink/remove images or shorten context`
              : 'shorten the context, or switch config.json mode to "direct"',
          },
        }))
        return
      }

      let result
      try {
        result = await wbipc.httpFetch({
          method: 'POST',
          path: '/v2/chat/completions',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: payload,
        })
      } catch (e) {
        const msg = String(e?.message ?? e)
        appendLog({
          ts: new Date().toISOString(), event: 'upstream_error', model: body.model,
          error: msg, code: e?.code, durationMs: Date.now() - t0,
          ...(CONFIG.logBodies ? { request: JSON.parse(bodyBuf.toString('utf8')) } : {}),
        })
        const inlineLimited = msg.includes('response exceeds inline limit')
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: inlineLimited
              ? `model thinking+output exceeded the 640 KB single-response IPC limit (max_completion_tokens=${upstreamBody.max_completion_tokens ?? 'unset'})`
              : `workbuddy backend unreachable: ${msg}`,
            hint: inlineLimited
              ? 'retry, switch to a lighter model, split the task, or switch config.json mode to "direct"'
              : 'make sure the WorkBuddy desktop app is running and logged in',
          },
        }))
        return
      }

      const bodyText = result.body.toString('utf8')
      const isSse = bodyText.includes('data: ')
      const { chunks, usage } = isSse ? parseSse(bodyText) : { chunks: [], usage: null }
      addSpend(usage?.credit ?? 0)
      markFreeExhaustedIfNeeded(body.model, usage?.credit ?? 0)

      if (CONFIG.logRequests) {
        appendLog({
          ts: new Date().toISOString(), event: 'request', mode: 'wbipc', model: body.model,
          status: result.status, durationMs: Date.now() - t0,
          ...logCtx,
          usage: usageSummary(usage),
          ...(CONFIG.logBodies ? {
            request: JSON.parse(bodyBuf.toString('utf8')),
            responsePreview: bodyText.slice(0, 2000),
          } : {}),
        })
      }

      if (result.status !== 200) {
        res.writeHead(result.status, { 'content-type': isSse ? 'text/event-stream' : 'application/json' })
        res.end(result.body)
        return
      }

      if (body.stream === true) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.end(bodyText)
      } else if (isSse) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(foldSseToCompletion(chunks, usage, body.model ?? 'proxy')))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(result.body)
      }
    } catch (e) {
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }))
      } catch { /* socket already gone */ }
    }
  })

  server.on('clientError', (_err, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') })
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  ctx.effect(() => {
    server.listen(CONFIG.port, '127.0.0.1', () => {
      appendLog({ ts: new Date().toISOString(), event: 'listening', port: CONFIG.port, mode: CONFIG.mode, realm: CONFIG.realm })
      if (!loadAuth() && CONFIG.mode === 'direct') {
        console.log(`[workbuddy-bridge] direct mode: no account yet — open http://127.0.0.1:${CONFIG.port}/login/page`)
      }
      if (CONFIG.logBodies) {
        console.log('[workbuddy-bridge] WARNING: logBodies=true stores full conversation text in logs/')
      }
    })
    return () => {
      server.close()
      clearInterval(catalogTimer)
      wbipc.drop()
    }
  })
}

// ---------------------------------------------------------------------------
// DSH tools (optional integration)
// ---------------------------------------------------------------------------

async function registerTools(ctx) {
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    // loose-directory install: fall back to the profile's node_modules
    try {
      ({ defineTool } = await import(pathToFileURL(path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href))
    } catch {
      return // tools are an optional integration
    }
  }
  if (typeof defineTool !== 'function' || !ctx?.tools) return

  ctx.tools.register(defineTool({
    name: 'workbuddy_account',
    description: 'Manage the WorkBuddy account used by this machine\'s model bridge: list saved accounts, switch the active account, check remaining credits, or get the QR-login panel URL. Use when the user asks to switch WorkBuddy accounts or check their credit balance.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'list | switch | balance | pricing | mode | login',
        enum: ['list', 'switch', 'balance', 'pricing', 'mode', 'login'],
      },
      uid: { type: 'string', description: 'account uid (required for action=switch)' },
      mode: { type: 'string', description: 'transport mode (required for action=mode): wbipc | direct' },
    },
    output: { schema: { type: 'string' } },
    async execute(args) {
      const base = `http://127.0.0.1:${CONFIG.port}`
      if (args.action === 'list') {
        const a = loadAuth()
        const accounts = listAuths()
        const lines = accounts.map((x) => {
          const cur = a && a.uid === x.uid ? ' [current]' : ''
          return `- ${x.nickname || x.uid}${cur} (updated ${x.updatedAt ?? '?'})`
        })
        return lines.length ? `Saved accounts:\n${lines.join('\n')}` : 'No saved accounts. Use action=login to add one.'
      }
      if (args.action === 'switch') {
        if (!args.uid) return 'uid is required for switch. Use action=list to see saved accounts.'
        const a = switchAuth(args.uid)
        return a
          ? `Switched to ${a.nickname || a.uid}. Takes effect on the next request — no restart needed.`
          : `No saved account with uid=${args.uid}. Use action=list to see saved accounts.`
      }
      if (args.action === 'balance') {
        try {
          const b = await direct.balance()
          return `Credits remaining: ${b.remain} / ${b.total} across ${b.packages} package(s). (Today spent via bridge: see panel.)`
        } catch (e) {
          return `Balance query failed: ${e?.message ?? e}. If not logged in, open ${base}/login/page`
        }
      }
      if (args.action === 'pricing') {
        const list = pricingList()
        if (!list.length) return `No pricing data yet. It is fetched automatically (hourly) once direct mode is logged in.`
        const fmt = (x) => {
          if (x.free && !x.exhausted) return `现在免费${x.note ? `（${x.note}）` : ''}`
          let t = `x${x.effective}`
          const detail = [
            ...(x.effective !== x.base ? [`原 x${x.base}`] : []),
            ...(x.label ? [x.label] : []),
            ...(x.note ? [x.note] : []),
            ...(x.exhausted ? ['今日免费额度已用完'] : []),
          ]
          return detail.length ? `${t} (${detail.join(' · ')})` : t
        }
        const lines = list.map((x) => `- ${x.name} [${x.id}]: ${fmt(x)}`)
        return `Current effective prices (Asia/Shanghai):\n${lines.join('\n')}`
      }
      if (args.action === 'mode') {
        const want = args.mode
        if (!want) return `Current transport mode: ${CONFIG.mode}. Pass mode="wbipc" or mode="direct" to switch.`
        if (want !== 'wbipc' && want !== 'direct') return `Unknown mode ${want}; expected wbipc or direct.`
        const notes = []
        if (want === 'direct' && !loadAuth()) notes.push('尚未登录，需打开面板扫码')
        if (want === 'wbipc') {
          try { readEndpoint() } catch { notes.push('WorkBuddy 桌面端未运行，切过去会 502') }
          notes.push('wbipc 有 768KB 请求 / 640KB 响应上限')
        }
        setMode(want)
        return `已切换到 ${want} 模式${notes.length ? '（' + notes.join('；') + '）' : ''}，下一个请求即生效，无需重启。`
      }
      if (args.action === 'login') {
        return `To add/switch accounts by WeChat QR scan, open the account panel in a browser: ${base}/login/page — then pick "开始新登录（扫码）". New logins take effect immediately without restarting.`
      }
      return `Unknown action: ${args.action}`
    },
  }))
}
