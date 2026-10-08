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
export const inject = ['tools']

// Data lives in a stable location independent of where this package is
// installed (loose plugin dir vs profile node_modules), so credentials and
// logs survive an upgrade from the manual install to the bundle install.
const DATA_DIR = path.join(os.homedir(), '.dsh', 'plugins', 'workbuddy-proxy')
const LOG_DIR = path.join(DATA_DIR, 'logs')
const AUTH_ROOT = path.join(DATA_DIR, 'auths')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }) } catch { /* exists */ }

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const DEFAULTS = {
  mode: 'wbipc', // 'wbipc' | 'direct'
  realm: 'cn', // 'cn' | 'global'
  port: 37321,
  authToken: '', // empty = generated on first start and persisted here
  dailyCreditBudget: 3000, // credits/day, 0 = unlimited
  perRequestCreditBudget: 1000, // estimated single-request cap (runaway guard), 0 = off
  logRequests: true,
  logBodies: false, // WARNING: true stores full conversation text on disk
  logRetentionDays: 7,
  clientVersion: '5.7.6', // WorkBuddy desktop version segment for UA; the backend
  //                         gates the model catalog on it, so a stale value here
  //                         silently shrinks the exposed list.
  cliVersion: '2.137.1', // CLI version segment for UA
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

// Credentials and the model catalog are partitioned per realm: a CN token must
// never be replayed against workbuddy.ai, and one merged catalog would keep
// advertising models the other realm retired.
function realmKey() { return CONFIG.realm === 'global' ? 'global' : 'cn' }
function realmAuthDir(rk = realmKey()) { return path.join(AUTH_ROOT, rk) }
function authFile(rk = realmKey()) { return path.join(realmAuthDir(rk), 'current.json') }
function catalogFile(rk = realmKey()) { return path.join(DATA_DIR, `catalog-${rk}.json`) }

// The pre-realm layout stored one shared auth.json plus auths/<uid>.json.
// Returns null when nothing identifies the realm: guessing "cn" here would park
// an international token where it gets replayed against copilot.tencent.com
// forever, so such records are quarantined for a human instead.
function legacyRealmOf(a) {
  if (a?.realm === 'cn' || a?.realm === 'global') return a.realm
  const domain = String(a?.domain ?? '')
  if (domain.includes('workbuddy.ai')) return 'global'
  if (domain.includes('codebuddy.cn') || domain.includes('copilot.tencent.com') || domain.includes('codebuddy.qq.com')) return 'cn'
  return null
}

function migrateLegacyAuth() {
  const flag = path.join(AUTH_ROOT, '.realm-split.done')
  if (fs.existsSync(flag)) return
  try { fs.mkdirSync(AUTH_ROOT, { recursive: true, mode: 0o700 }) } catch { /* exists */ }
  const sources = []
  try {
    for (const f of fs.readdirSync(AUTH_ROOT)) if (f.endsWith('.json')) sources.push({ src: path.join(AUTH_ROOT, f), base: f })
  } catch { /* nothing to migrate */ }
  const legacyCurrent = path.join(DATA_DIR, 'auth.json')
  if (fs.existsSync(legacyCurrent)) sources.push({ src: legacyCurrent, base: 'auth.json', destName: 'current.json' })

  let placed = 0
  let quarantined = 0
  let failed = 0
  for (const { src, base, destName } of sources) {
    let rec = null
    try { rec = JSON.parse(fs.readFileSync(src, 'utf8')) } catch { failed++; continue }
    const uid = rec?.uid
    if (!uid && !destName) { failed++; continue }
    const rk = legacyRealmOf(rec)
    if (!rk) {
      // No realm evidence: keep the token, but out of the load path rather than
      // guessing a realm and replaying it against the wrong backend.
      try {
        const q = path.join(AUTH_ROOT, 'unsorted')
        fs.mkdirSync(q, { recursive: true, mode: 0o700 })
        fs.renameSync(src, path.join(q, destName ? base : `${uid}.json`))
        quarantined++
      } catch { failed++ }
      continue
    }
    const dir = path.join(AUTH_ROOT, rk)
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const dest = path.join(dir, destName ?? `${uid}.json`)
      if (!fs.existsSync(dest)) fs.copyFileSync(src, dest)
      placed++
    } catch { failed++ }
  }
  // Only a run where nothing went wrong may retire the legacy copies and mark
  // itself complete; a partial run retries on the next start.
  if (failed === 0) {
    for (const { src, base } of sources) {
      if (base === 'auth.json') continue // left below
      try { fs.renameSync(src, `${src}.migrated`) } catch { /* best effort */ }
    }
    try { if (fs.existsSync(legacyCurrent)) fs.renameSync(legacyCurrent, `${legacyCurrent}.migrated`) } catch { /* best effort */ }
    try {
      fs.writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), placed, quarantined }))
    } catch { /* best effort */ }
  }
  if (placed || quarantined || failed) {
    appendLog({ ts: new Date().toISOString(), event: 'auth_realm_migration', placed, quarantined, failed })
  }
}
migrateLegacyAuth()

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

function setRealm(next) {
  if (next !== 'cn' && next !== 'global') return false
  if (next === CONFIG.realm) return true
  CONFIG.realm = next
  try {
    const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    disk.realm = next
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(disk, null, 2), { mode: 0o600 })
  } catch { /* in-memory switch still applies */ }
  // Everything realm-derived has to be re-read: the catalog, the desktop IPC
  // connection, and a login started against the other realm must not land here.
  try {
    catalog = JSON.parse(fs.readFileSync(catalogFile(), 'utf8'))
  } catch {
    catalog = { models: {}, promos: {}, picker: [], fetchedAt: null }
  }
  if (!Array.isArray(catalog.picker)) catalog.picker = []
  spendLoaded = false // each realm carries its own daily allowance
  wbipc.drop()
  pendingLogin = null
  appendLog({ ts: new Date().toISOString(), event: 'realm_switch', realm: next })
  return true
}

function realmSwitchWarnings() {
  const w = []
  if (!loadAuth()) w.push(`${CONFIG.realm === 'global' ? '国际版' : '国内版'}还没有登录凭证：模型列表会保持上一次的内容，直到你扫码`)
  try { readEndpoint() } catch { w.push(`对应桌面端未运行，wbipc 请求会失败（${realm().configDir}）`) }
  if (wbipcPinned()) w.push(`WORKBUDDY_CONFIG_DIR/CODEBUDDY_CONFIG_DIR 已把 IPC 钉死在 ${wbipcConfigDir()}，切换 realm 不会改连到另一个桌面端`)
  return w
}

const REALMS = {
  cn: {
    chatBase: 'https://copilot.tencent.com',
    billingBase: 'https://www.codebuddy.cn',
    origin: 'https://www.codebuddy.cn',
    acceptLanguage: 'zh-CN',
    uaPlatform: 'WorkBuddy',
    configDir: '.workbuddy',
  },
  global: {
    chatBase: 'https://www.workbuddy.ai',
    billingBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    acceptLanguage: 'en-US',
    uaPlatform: 'WorkBuddy AI',
    configDir: '.workbuddy-ai',
  },
}

function realm() { return REALMS[CONFIG.realm] ?? REALMS.cn }

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

// Local calendar day, not UTC: the budget, the price windows and the log file
// names all follow the user's clock (a UTC day would roll the budget at 08:00).
function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function todayLogPath() {
  return path.join(LOG_DIR, `${localDay()}.jsonl`)
}

function appendLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    // Every entry carries the realm it was recorded under, so each realm's
    // daily budget can be rebuilt from the log alone.
    fs.appendFileSync(todayLogPath(), JSON.stringify({ realm: CONFIG.realm, ...entry }) + '\n')
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
let spendLoaded = false
let spendRealm = ''

function stateFile(rk = realmKey()) { return path.join(DATA_DIR, `state-${rk}.json`) }

// state.json is only a cache. The day's request log is keyed by the same local
// day and is what actually got charged, so rebuild from it once per day: a
// stale, truncated or hand-edited state file must never disable the guard
// (v1.0.x shipped a counter that read 0 while 1348 credits were already gone).
// Each realm bills its own account, so each realm gets its own budget: spending
// the CN allowance must not lock out a fresh international account or reverse.
// Entries written before the realm was recorded are CN-era traffic and stay in
// the CN ledger.
function spendFromLog(day, rk) {
  if (!CONFIG.logRequests) return null // request entries are not being written; logs hold no charge data
  let raw
  try { raw = fs.readFileSync(path.join(LOG_DIR, `${day}.jsonl`), 'utf8') } catch { return null }
  let total = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if ((e?.realm ?? 'cn') !== rk) continue
    const c = e?.usage?.credit
    if (typeof c === 'number' && c > 0) total += c
  }
  return total
}

function persistSpend() {
  try { fs.writeFileSync(stateFile(), JSON.stringify(spend), { mode: 0o600 }) } catch { /* ignore */ }
}

function loadSpend() {
  const day = localDay()
  const rk = realmKey()
  if (spendLoaded && spend.date === day && spendRealm === rk) return
  const fromLog = spendFromLog(day, rk)
  if (fromLog != null) {
    spend = { date: day, credits: fromLog }
  } else {
    spend = { date: day, credits: 0 }
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(rk), 'utf8'))
      if (s?.date === day && typeof s?.credits === 'number') spend = s
    } catch { /* first run */ }
  }
  spendLoaded = true
  spendRealm = rk
  persistSpend()
}

function addSpend(credit) {
  loadSpend()
  spend.credits += credit || 0
  persistSpend()
}

function budgetBlocked() {
  if (!(CONFIG.dailyCreditBudget > 0)) return false
  loadSpend()
  return spend.credits >= CONFIG.dailyCreditBudget
}

// ---------------------------------------------------------------------------
// auth store (direct mode): plaintext tokens, restricted file permissions
// ---------------------------------------------------------------------------

function loadAuth(rk = realmKey()) {
  try {
    const a = JSON.parse(fs.readFileSync(authFile(rk), 'utf8'))
    if (!a?.accessToken) return null
    // A record stamped with another realm must never be replayed here; records
    // predating the split carry no stamp and are trusted by their directory.
    if (a.realm && a.realm !== rk) return null
    return a
  } catch { return null }
}

function saveAuth(a, rk = realmKey()) {
  a.updatedAt = new Date().toISOString()
  a.realm = rk
  const dir = realmAuthDir(rk)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = authFile(rk)
  fs.writeFileSync(file, JSON.stringify(a, null, 2), { mode: 0o600 })
  try { fs.chmodSync(file, 0o600) } catch { /* best effort on win32 */ }
  if (a.uid) {
    try {
      fs.writeFileSync(path.join(dir, `${a.uid}.json`), JSON.stringify(a, null, 2), { mode: 0o600 })
    } catch { /* best effort */ }
  }
}

function listAuths() {
  try {
    return fs.readdirSync(realmAuthDir()).filter((f) => f.endsWith('.json') && f !== 'current.json').map((f) => {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(realmAuthDir(), f), 'utf8'))
        return { uid: a.uid ?? f.replace(/\.json$/, ''), nickname: a.nickname, updatedAt: a.updatedAt }
      } catch { return { uid: f.replace(/\.json$/, '') } }
    })
  } catch { return [] }
}

function switchAuth(uid) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(realmAuthDir(), `${uid}.json`), 'utf8'))
    if (!a?.accessToken) return null
    saveAuth(a)
    return a
  } catch { return null }
}

// ---------------------------------------------------------------------------
// header builders (mirrors the official client's outbound header families)
// ---------------------------------------------------------------------------

function threeSegmentUA(r = realm()) {
  return `WorkBuddy/${CONFIG.clientVersion} ${r.uaPlatform}/${CONFIG.clientVersion} CLI/${CONFIG.cliVersion}`
}

function hex36(seed) {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 36)
}

function msgId() { return crypto.randomUUID().replace(/-/g, '') }

function loginHeaders(r = realm()) {
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

function chatHeaders(a, convReqId, r = realm()) {
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

const SH_OFFSET_MS = 8 * 3600_000 // Asia/Shanghai has no DST

let catalog = { models: {}, promos: {}, picker: [], fetchedAt: null }
try { catalog = JSON.parse(fs.readFileSync(catalogFile(), 'utf8')) } catch { /* first run */ }
if (!Array.isArray(catalog.picker)) catalog.picker = []

// The vendor's router tiers (Auto / Fast / Balanced / Primary / Deep) resolve to
// a model chosen per request and bill at a floating multiplier, so they are not
// something to hand to DSH as a selectable model.
function isRouterTier(id) { return id === 'auto' || id === 'default' || /-model$/.test(id) }

// Model ids are echoed into a YAML file that the harness loads; keep them to
// what a model id actually looks like in either realm.
const SAFE_MODEL_ID = /^[\w][\w.@:-]{0,63}$/

function positiveInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

async function fetchCatalog() {
  const rk = realmKey()
  const a = loadAuth(rk)
  if (!a) return // the catalog needs direct-mode credentials
  const r = REALMS[rk] ?? REALMS.cn
  // The backend gates the catalog on the client UA. Only the desktop client's
  // three-segment UA returns the merged product+account config the picker
  // actually uses — the CLI UA and the IDE UA each return a smaller, older
  // list with no promotions, which is what made the exposed models drift.
  const res = await fetch(`${r.chatBase}/v3/config`, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      authorization: `Bearer ${a.accessToken}`,
      'x-user-id': a.uid ?? '',
      'x-domain': new URL(r.chatBase).host,
      'x-product': 'SaaS',
      'user-agent': threeSegmentUA(),
      'x-codebuddy-request': '1',
      'accept-language': r.acceptLanguage,
    },
  })
  const env = await res.json().catch(() => null)
  const data = env?.data
  if (!data?.models?.length) return
  const models = {}
  for (const m of data.models) models[m.id] = m
  const promos = {}
  for (const p of data.modelPromotions ?? []) {
    if (!p.enabled) continue
    for (const mid of p.modelIds ?? []) (promos[mid] ??= []).push(p)
  }
  const agent = (data.agents ?? []).find((x) => (x.tags ?? []).includes('default'))
  const picker = (agent?.models ?? []).filter((id) => !isRouterTier(id) && models[id])
  // A retired model has to disappear, so a successful fetch replaces the
  // catalog outright instead of merging into yesterday's copy. An empty picker
  // keeps the previous one rather than silently blanking the provider.
  if (realmKey() !== rk) return // realm switched during the await: nothing above is valid
  catalog = {
    models,
    promos,
    picker: picker.length ? picker : catalog.picker,
    fetchedAt: new Date().toISOString(),
  }
  try { fs.writeFileSync(catalogFile(rk), JSON.stringify(catalog)) } catch { /* ignore */ }
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
  loadFreeExhausted()
  const exhausted = freeExhausted[freeKey(mid)]
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

// What DSH should offer: the realm's live picker whitelist, and nothing else.
// Falling back to the bundled list here would re-introduce the stale snapshot
// this whole path exists to remove.
function exposedModels() {
  const ids = catalog.picker
  const out = []
  for (const id of ids) {
    const m = catalog.models[id]
    if (!m) continue
    // The id and both capacity numbers reach an unquoted or plainly-quoted YAML
    // slot, and they originate from a network response: constrain them here
    // rather than trusting the emitter.
    if (!SAFE_MODEL_ID.test(id)) continue
    const contextWindow = positiveInt(m.maxInputTokens)
    if (contextWindow === 0) continue
    const maxTokens = positiveInt(m.maxOutputTokens)
    const ep = effectivePrice(id)
    const base = typeof m.name === 'string' && m.name ? m.name : id
    let name = base
    if (ep?.free) name = `${base} (现免费)`
    else if (ep) name = ep.effective === ep.base ? `${base} (x${ep.base})` : `${base} (x${ep.effective}·原价x${ep.base})`
    out.push({
      id,
      name,
      input: m.supportsImages === false ? ['text'] : ['text', 'image'],
      contextWindow,
      maxTokens,
    })
  }
  // The vendor ships distinct ids under one display name (hy4-preview and
  // hy4-preview-f are both "Hy4 preview"), which is unclickable in a flat
  // picker; only labels that actually collide get their id appended.
  const count = new Map()
  for (const m of out) count.set(m.name, (count.get(m.name) ?? 0) + 1)
  for (const m of out) if (count.get(m.name) > 1) m.name = `${m.name}·${m.id}`
  return out
}

// pricing snapshot for panel/tool — restricted to the models we actually expose
function pricingList() {
  const out = []
  for (const e of exposedModels()) {
    const ep = effectivePrice(e.id)
    if (!ep) continue
    const m = catalog.models[e.id]
    out.push({
      id: e.id,
      name: m.name || e.id,
      base: ep.base,
      effective: ep.effective,
      free: !!ep.free,
      label: ep.label ?? '',
      note: ep.note ?? '',
      exhausted: !!ep.exhausted,
    })
  }
  return out.sort((a, b) => (a.effective ?? 9) - (b.effective ?? 9))
}

// ---------------------------------------------------------------------------
// DSH provider declaration: the model list lives in the harness home patch so
// the picker follows the live catalog. dsh-hmr watches this exact file and
// recomposes the profile, so a change applies without restarting Harness; a
// patch row with the same id replaces the whole `config`, which is why the
// block restates every provider field rather than only `models`.
// ---------------------------------------------------------------------------

const HOME_PATCH_FILE = path.join(os.homedir(), '.dsh', 'cordis.patch.yml')
const BLOCK_BEGIN = '# >>> generated by dsh-workbuddy-bridge — do not edit this block'
const BLOCK_END = '# <<< generated by dsh-workbuddy-bridge'

// JSON.stringify leaves U+0085 / U+2028 / U+2029 raw, and some YAML parsers
// end a quoted scalar at those, so escape them too.
const yamlStr = (s) => JSON.stringify(String(s)).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

function providerDisplayName() {
  return CONFIG.realm === 'global' ? 'WorkBuddy 国际版 (预积分计费)' : 'WorkBuddy 国内版 (预积分计费)'
}

function renderProviderBlock(models) {
  const lines = [
    BLOCK_BEGIN,
    '- id: llm-pi-ai',
    `  name: '@deepseek-ai/dsh-llm-pi-ai'`,
    '  config:',
    '    providers:',
    '      workbuddy:',
    `        displayName: ${yamlStr(providerDisplayName())}`,
    '        apiKeyEnv: WORKBUDDY_PROXY_KEY',
    '        api: openai-completions',
    `        baseURL: ${yamlStr(`http://127.0.0.1:${CONFIG.port}/v1`)}`,
    '        models:',
  ]
  for (const m of models) {
    lines.push(`        - id: ${yamlStr(m.id)}`)
    lines.push(`          name: ${yamlStr(m.name)}`)
    lines.push('          input:')
    for (const mod of m.input) lines.push(`          - ${yamlStr(mod)}`)
    lines.push(`          contextWindow: ${m.contextWindow}`)
    lines.push(`          maxTokens: ${m.maxTokens}`)
  }
  lines.push(BLOCK_END)
  return lines.join('\n') + '\n'
}

// Markers are only recognised as whole comment lines, and an ambiguous file is
// refused rather than guessed at: the previous indexOf arithmetic silently
// deleted whatever sat between a user's stray begin marker and our own end one.
function spliceManagedBlock(existing, block) {
  const lines = (existing ?? '').split('\n')
  const isBegin = (l) => l.trimEnd() === BLOCK_BEGIN
  const isEnd = (l) => l.trimEnd() === BLOCK_END
  let begin = -1
  for (let i = 0; i < lines.length; i++) if (isBegin(lines[i])) begin = i
  if (begin < 0) {
    if (lines.some(isEnd)) return { error: 'stray end marker without a matching begin marker' }
    const text = lines.join('\n')
    return { text: text.trim().length ? `${text.replace(/\n*$/, '')}\n\n${block}` : block }
  }
  let end = -1
  for (let i = begin + 1; i < lines.length; i++) {
    if (isBegin(lines[i])) return { error: 'nested begin markers' }
    if (isEnd(lines[i])) { end = i; break }
  }
  if (end < 0) return { error: 'managed block is unterminated' }
  for (let i = 0; i < begin; i++) if (isBegin(lines[i]) || isEnd(lines[i])) return { error: 'stray markers above the managed block' }
  return { text: [...lines.slice(0, begin), ...block.replace(/\n+$/, '').split('\n'), ...lines.slice(end + 1)].join('\n') }
}

let providerSync = { state: 'pending', models: 0, at: null, error: null }

function syncProviderPatch() {
  const models = exposedModels()
  if (models.length === 0) {
    providerSync = { state: 'no-catalog', models: 0, at: new Date().toISOString(), error: 'no live catalog for this realm — log in once so the bridge can read the model whitelist' }
    return providerSync
  }
  const block = renderProviderBlock(models)
  let current = null
  try { current = fs.readFileSync(HOME_PATCH_FILE, 'utf8') } catch { /* first write */ }
  const spliced = spliceManagedBlock(current, block)
  if (spliced.error) {
    providerSync = { state: 'refused', models: models.length, at: new Date().toISOString(), error: `${HOME_PATCH_FILE}: ${spliced.error}; not overwriting` }
    appendLog({ ts: new Date().toISOString(), event: 'provider_patch_refused', error: providerSync.error })
    return providerSync
  }
  if (current === spliced.text) {
    providerSync = { state: 'in-sync', models: models.length, at: providerSync.at ?? new Date().toISOString(), error: null }
    return providerSync
  }
  const tmp = `${HOME_PATCH_FILE}.dsh-workbuddy-${process.pid}-${Date.now()}.tmp`
  try {
    // 'wx' so a pre-existing or symlinked temp path can never be followed, and
    // so two instances cannot truncate each other's file.
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try { fs.writeFileSync(fd, spliced.text) } finally { fs.closeSync(fd) }
    if (current !== null) {
      const last = `${HOME_PATCH_FILE}.last`
      const lfd = fs.openSync(last, 'w', 0o600)
      try { fs.writeFileSync(lfd, current) } finally { fs.closeSync(lfd) }
    }
    fs.renameSync(tmp, HOME_PATCH_FILE)
    providerSync = { state: 'written', models: models.length, at: new Date().toISOString(), error: null }
    appendLog({ ts: new Date().toISOString(), event: 'provider_patch', models: models.length, realm: CONFIG.realm })
  } catch (e) {
    providerSync = { state: 'failed', models: models.length, at: new Date().toISOString(), error: String(e?.message ?? e) }
    appendLog({ ts: new Date().toISOString(), event: 'provider_patch_failed', error: providerSync.error })
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
  }
  return providerSync
}

async function refreshProvider() {
  await fetchCatalog().catch(() => {})
  return syncProviderPatch()
}

// A realm that yields no models must never be left live: the provider row would
// keep advertising the previous realm's ids against the new token and endpoint.
async function switchRealmGuarded(next) {
  const prev = CONFIG.realm
  if (prev !== next) setRealm(next)
  await fetchCatalog().catch(() => {})
  if (exposedModels().length === 0) {
    if (prev !== next) setRealm(prev)
    return {
      ok: false,
      realm: CONFIG.realm,
      error: `${next === 'global' ? '国际版' : '国内版'}拿不到模型目录（该站点需要先有一次 direct 登录），已回退到 ${providerDisplayName()}`,
    }
  }
  return { ok: true, realm: CONFIG.realm, warnings: realmSwitchWarnings(), provider: syncProviderPatch() }
}

// free-quota exhaustion: a model whose promo price is 0 but that returned
// credit > 0 has used up its daily free allowance — record for today.
let freeExhausted = {}
// Both the day and the realm are part of the key: a model that burned its free
// allowance on CN says nothing about the same id on the international account.
function loadFreeExhausted() {
  loadSpend() // ensures spend.date is today
  const key = `${spend.date}:${realmKey()}`
  if (freeExhausted.__key !== key) freeExhausted = { __key: key }
}

function freeKey(modelId) { return `${realmKey()}:${modelId}` }

function markFreeExhaustedIfNeeded(modelId, credit) {
  if (!credit) return
  const ep = effectivePrice(modelId)
  if (ep?.free) {
    loadFreeExhausted()
    freeExhausted[freeKey(modelId)] = true
    appendLog({ ts: new Date().toISOString(), event: 'free_quota_exhausted', model: modelId })
  }
}

// ---------------------------------------------------------------------------
// direct client: refresh + streaming chat + balance
// ---------------------------------------------------------------------------

class DirectClient {
  constructor() { this.refreshing = null }

  async refreshForce(a, rk = realmKey()) {
    const r = REALMS[rk] ?? REALMS.cn
    const res = await fetch(`${r.chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        ...loginHeaders(r),
        'user-agent': threeSegmentUA(r),
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
    saveAuth(a, rk)
    appendLog({ ts: new Date().toISOString(), event: 'token_refreshed', uid: a.uid, realm: rk })
  }

  async ensureToken(rk = realmKey()) {
    const a = loadAuth(rk)
    if (!a) throw Object.assign(new Error('direct mode is not logged in'), { needsLogin: true })
    if (a.expiresAt && a.expiresAt - Date.now() < 10 * 60 * 1000 && a.refreshToken) {
      this.refreshing ??= this.refreshForce(a, rk).finally(() => { this.refreshing = null })
      await this.refreshing
    }
    return a
  }

  // The realm can be switched by the panel while a request is in flight, so the
  // realm, the endpoint and the token are all pinned here: a cn bearer must
  // never be sent to workbuddy.ai just because the switch landed mid-await.
  async openAuthorized(payloadStr, signal) {
    const rk = realmKey()
    const r = REALMS[rk] ?? REALMS.cn
    const stillPinned = () => {
      if (realmKey() !== rk) throw Object.assign(new Error(`realm changed to ${rk === 'global' ? 'cn' : 'global'} mid-request; retry`), { realmChanged: true })
    }
    let a = await this.ensureToken(rk)
    stillPinned()
    const convReqId = msgId()
    let upstream = await this.send(a, payloadStr, convReqId, signal, r)
    if (upstream.status === 401 && a.refreshToken) {
      appendLog({ ts: new Date().toISOString(), event: 'token_401_retry', uid: a.uid, realm: rk })
      await this.refreshForce(a, rk)
      stillPinned()
      a = loadAuth(rk)
      upstream = await this.send(a, payloadStr, convReqId, signal, r)
    }
    return upstream
  }

  // `stream: false` still has to answer with one JSON completion, so the SSE is
  // collected and folded instead of pumped to the client.
  async chatCollected(payloadStr, req, logCtx) {
    const t0 = Date.now()
    const model = JSON.parse(payloadStr).model
    const ac = new AbortController()
    req.on('close', () => ac.abort(new Error('client disconnected')))
    let status = 0
    let usage = null
    try {
      const upstream = await this.openAuthorized(payloadStr, ac.signal)
      status = upstream.status
      const text = await upstream.text()
      const isSse = text.includes('data: ')
      const parsed = isSse ? parseSse(text) : { chunks: [], usage: null }
      usage = parsed.usage
      return { status, isSse, text, chunks: parsed.chunks, usage, model }
    } finally {
      // A client that walks away mid-collect must still reach the ledger, or
      // the credits it actually spent go uncounted.
      addSpend(usage?.credit ?? 0)
      markFreeExhaustedIfNeeded(model, usage?.credit ?? 0)
      if (CONFIG.logRequests) {
        appendLog({
          ts: new Date().toISOString(), event: 'request', mode: 'direct', status,
          model, durationMs: Date.now() - t0, ...logCtx, usage: usageSummary(usage),
        })
      }
    }
  }

  async chat(payloadStr, res, req, logCtx) {
    const t0 = Date.now()
    const ac = new AbortController()
    req.on('close', () => ac.abort(new Error('client disconnected')))

    const upstream = await this.openAuthorized(payloadStr, ac.signal)

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
    let bytes = 0
    const model = JSON.parse(payloadStr).model
    const reader = upstream.body.getReader()
    let aborted = null
    // Upstream stall guard: DSH's stream-idle watchdog (300s, provider-tunable)
    // aborts from the client side, but if DSH is configured loose or the client
    // walks away mid-stream, nothing else would cut a dead upstream. 600s of
    // zero bytes is far beyond any observed prefill (worst measured: 243s).
    const UPSTREAM_IDLE_MS = 600000
    let lastByteAt = Date.now()
    let firstByteMs = null
    const guard = setInterval(() => {
      if (Date.now() - lastByteAt >= UPSTREAM_IDLE_MS) {
        ac.abort(new Error(`upstream idle ${UPSTREAM_IDLE_MS}ms`))
      }
    }, 15000)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstByteMs === null) firstByteMs = Date.now() - t0
        lastByteAt = Date.now()
        bytes += value?.byteLength ?? 0
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
    } catch (err) {
      // DSH's stream idle watchdog closes the connection mid-stream; the request
      // still has to reach the ledger below or spend goes uncounted.
      aborted = err?.message ?? String(err)
    } finally {
      clearInterval(guard)
      try { reader.releaseLock() } catch { /* stream already released */ }
      addSpend(usage.credit)
      markFreeExhaustedIfNeeded(model, usage.credit)
      appendLog({
        ts: new Date().toISOString(), event: 'request', mode: 'direct', ...logCtx,
        status: upstream.status, model, durationMs: Date.now() - t0, sseBytes: bytes,
        firstByteMs, aborted,
        usage: usage.prompt !== null ? {
          prompt_tokens: usage.prompt, prompt_cache_hit_tokens: usage.cacheHit,
          prompt_cache_miss_tokens: usage.cacheMiss, credit: usage.credit,
        } : null,
      })
    }
    if (aborted) res.destroy()
  }

  send(a, payloadStr, convReqId, signal, r = realm()) {
    return fetch(`${r.chatBase}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(a, convReqId, r),
      body: payloadStr,
      signal,
    })
  }

  async balance() {
    const r = realm()
    // Identity follows the transport: wbipc lets the desktop app sign the query
    // (its account is the one actually being charged); direct uses the stored
    // account's own token. Endpoint and response shape differ per realm: CN
    // reads get-user-resource (Accounts), international reads
    // get-user-resource-summary (Packages, carrying the remain/total directly).
    const post = async (p, body) => {
      if (CONFIG.mode === 'wbipc') {
        const res = await wbipc.httpFetch({
          method: 'POST', path: p,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify(body)),
        })
        const text = res.body.toString('utf8')
        if (res.status !== 200) throw new Error(`billing ${p} -> HTTP ${res.status}: ${text.slice(0, 200)}`)
        let parsed
        try { parsed = JSON.parse(text) } catch { throw new Error(`billing ${p}: non-JSON response: ${text.slice(0, 200)}`) }
        if (parsed == null) throw new Error(`billing ${p}: null body (HTTP ${res.status}): ${text.slice(0, 200)}`)
        return parsed
      }
      const a = await this.ensureToken()
      const res = await fetch(`${r.billingBase}${p}`, {
        method: 'POST',
        headers: billingHeaders(a),
        body: JSON.stringify(body),
      })
      return res.json().catch(() => null)
    }
    if (r === REALMS.global) {
      const env = await post('/billing/meter/get-user-resource-summary', {})
      if (env?.code !== 0) throw new Error(`billing summary failed: code=${env?.code ?? '?'} msg=${env?.msg ?? JSON.stringify(env).slice(0, 200)}`)
      const pkgs = env?.data?.Packages ?? []
      let remain = 0
      let total = 0
      for (const p of pkgs) {
        const left = Number(p.CycleRemainCapacity) || 0
        const size = Number(p.CycleTotalCapacity) || 0
        remain += Math.max(0, left)
        total += Math.max(size, left)
      }
      return { remain, total, packages: pkgs.length, subscription: env?.data?.SubscriptionPackageName ?? '' }
    }
    const layout = (d) => {
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }
    const end = new Date(Date.now() + 365 * 101 * 86400_000)
    const env = await post('/v2/billing/meter/get-user-resource', {
      PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
      PackageEndTimeRangeBegin: layout(new Date()),
      PackageEndTimeRangeEnd: layout(end),
    })
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

// Each desktop build keeps its own config dir; the international client writes
// to ~/.workbuddy-ai, so guessing one path loses the other realm's app.
function wbipcPinned() { return Boolean(process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR) }
function wbipcConfigDir() {
  return process.env.WORKBUDDY_CONFIG_DIR
    || process.env.CODEBUDDY_CONFIG_DIR
    || path.join(os.homedir(), realm().configDir)
}
function wbipcEndpointFile() {
  return path.join(wbipcConfigDir(), 'wbipc', 'endpoint.json')
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

// Module-level singleton: both the chat forwarder and DirectClient.balance()
// need the same pipe connection.
const wbipc = new WbipcClient()

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
    if (ch.delta?.tool_calls) {
      // Streaming delivers a call's arguments in fragments keyed by index;
      // collecting the deltas verbatim would emit several truncated calls.
      for (const d of ch.delta.tool_calls) {
        const key = Number.isInteger(d.index) ? d.index : 0
        let t = toolCalls.find((x) => x.slot === key)
        if (!t) {
          t = { slot: key, id: undefined, type: 'function', function: { name: '', arguments: '' } }
          toolCalls.push(t)
        }
        if (d.id) t.id = d.id
        if (d.type) t.type = d.type
        if (typeof d.function?.name === 'string') t.function.name += d.function.name
        if (typeof d.function?.arguments === 'string') t.function.arguments += d.function.arguments
      }
    }
    if (ch.finish_reason) finishReason = ch.finish_reason
  }
  const message = { role: 'assistant', content: contentParts.join('') }
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join('')
  if (toolCalls.length) message.tool_calls = toolCalls.map(({ slot, ...rest }) => rest)
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
// DSH web-server surface (`/workbuddy/*`)
//
// The in-DSH settings panel (client half) talks to us over DSH's own web
// server so there is no cross-origin call to 127.0.0.1:<port>. Because that
// server may be reachable beyond loopback (public deployments), every route
// requires the shared bearer token; the only unauthenticated route is
// /workbuddy/bootstrap, which hands the token to a browser page that proves
// it is same-origin via Sec-Fetch-Site (a web page cannot forge that header).
// ---------------------------------------------------------------------------

const WEB_PREFIX = '/workbuddy'

const direct = new DirectClient()

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length })
  res.end(buf)
}

function webSummary() {
  const a = loadAuth()
  loadSpend()
  let wbipcOk = false
  try { readEndpoint(); wbipcOk = true } catch { /* desktop not running */ }
  return {
    mode: CONFIG.mode,
    realm: CONFIG.realm,
    port: CONFIG.port,
    workbuddyIpc: wbipcOk,
    tool: toolStatus,
    // In wbipc mode the spending identity is the desktop app's account (the
    // stored direct-mode account is not who gets billed), so say so instead of
    // parading the stored nickname.
    account: CONFIG.mode === 'wbipc'
      ? { uid: '', nickname: `桌面端 (${CONFIG.realm === 'global' ? '国际版' : '国内版'})`, expiresAt: 0, via: 'wbipc' }
      : a ? { uid: a.uid, nickname: a.nickname, expiresAt: a.expiresAt } : null,
    accounts: listAuths(),
    spendToday: Math.round((spend.credits ?? 0) * 1000) / 1000,
    dailyCreditBudget: CONFIG.dailyCreditBudget,
    perRequestCreditBudget: CONFIG.perRequestCreditBudget,
    catalogFetchedAt: catalog.fetchedAt,
    pricing: pricingList(),
  }
}

// A browser page always attaches Sec-Fetch-Site and script cannot delete it, so
// its absence means the request did not originate from a web page. DSH's desktop
// shell forwards panel fetches through its dsh-app:// proxy, which drops
// sec-fetch-site + origin and injects its own Host session cookie — that header
// shape is what the same UI looks like when it arrives from the app.
function isLocalUi(req) {
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'none') return true
  return site === undefined && req.headers.cookie !== undefined
}

async function webHandler(req, res) {
  const url = (req.url ?? '').split('?')[0]
  const sub = url.slice(WEB_PREFIX.length) || '/'
  try {
    // token bootstrap: for the DSH UI itself — either the browser page on the
    // host's http origin (sec-fetch-site: same-origin) or the desktop shell,
    // whose dsh-app:// proxy strips sec-fetch-site/origin and injects its own
    // session cookie before forwarding here.
    if (req.method === 'GET' && sub === '/bootstrap') {
      if (!isLocalUi(req)) {
        sendJson(res, 403, { error: { message: 'local UI only' } })
        return
      }
      sendJson(res, 200, { token: CONFIG.authToken })
      return
    }
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${CONFIG.authToken}`) {
      sendJson(res, 401, { error: { message: 'unauthorized' } })
      return
    }

    if (req.method === 'GET' && (sub === '/summary' || sub === '/')) {
      sendJson(res, 200, webSummary())
      return
    }
    if (req.method === 'GET' && sub === '/pricing') {
      sendJson(res, 200, { fetchedAt: catalog.fetchedAt, models: pricingList() })
      return
    }
    if (req.method === 'GET' && sub === '/balance') {
      sendJson(res, 200, await direct.balance())
      return
    }
    if (req.method === 'POST' && sub === '/mode') {
      const body = await readRequestBody(req)
      const mode = String(body.mode ?? '')
      if (mode !== 'wbipc' && mode !== 'direct') { sendJson(res, 400, { error: { message: 'mode must be wbipc or direct' } }); return }
      const warnings = []
      if (mode === 'direct' && !loadAuth()) warnings.push('direct 模式尚未登录，请先扫码')
      if (mode === 'wbipc') {
        try { readEndpoint() } catch { warnings.push('WorkBuddy 桌面端未运行，wbipc 请求会失败') }
        warnings.push('wbipc 通道有 768KB 请求 / 640KB 响应上限')
      }
      setMode(mode)
      sendJson(res, 200, { ok: true, mode, warnings })
      return
    }
    if (req.method === 'POST' && sub === '/realm') {
      const body = await readRequestBody(req)
      const next = String(body.realm ?? '')
      if (next !== 'cn' && next !== 'global') { sendJson(res, 400, { error: { message: 'realm must be cn or global' } }); return }
      const switched = await switchRealmGuarded(next)
      if (!switched.ok) { sendJson(res, 409, { error: { message: switched.error }, realm: CONFIG.realm }); return }
      sendJson(res, 200, { ok: true, realm: switched.realm, mode: CONFIG.mode, warnings: switched.warnings, provider: switched.provider })
      return
    }
    if (req.method === 'POST' && sub === '/accounts/switch') {
      const body = await readRequestBody(req)
      const a = switchAuth(String(body.uid ?? ''))
      if (!a) { sendJson(res, 404, { error: { message: 'no such saved account' } }); return }
      appendLog({ ts: new Date().toISOString(), event: 'account_switch', uid: a.uid, nickname: a.nickname })
      sendJson(res, 200, { ok: true, uid: a.uid, nickname: a.nickname })
      return
    }
    if (req.method === 'POST' && sub === '/login') {
      const r = await fetch(`${realm().chatBase}/v2/plugin/auth/state?platform=CLI`, { method: 'POST', headers: loginHeaders(), body: '{}' })
      const env = await r.json().catch(() => null)
      if (!env?.data?.state || !env?.data?.authUrl) { sendJson(res, 502, { error: { message: `auth/state failed: HTTP ${r.status}` } }); return }
      pendingLogin = { state: env.data.state, startedAt: Date.now() }
      sendJson(res, 200, { state: env.data.state, authUrl: env.data.authUrl })
      return
    }
    if (req.method === 'GET' && sub === '/login/poll') {
      if (!pendingLogin || Date.now() - pendingLogin.startedAt > 10 * 60 * 1000) {
        sendJson(res, 400, { error: { message: 'no pending login' } })
        return
      }
      const r = await fetch(`${realm().chatBase}/v2/plugin/auth/token?state=${pendingLogin.state}`, { headers: loginHeaders() })
      const env = await r.json().catch(() => null)
      const tok = env?.data
      if (!env || env.code !== 0 || !tok?.accessToken) { sendJson(res, 200, { status: 'pending' }); return }
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
        if (aenv?.data?.uid) { a.uid = aenv.data.uid; a.enterpriseId = aenv.data.enterpriseId || undefined; a.nickname = aenv.data.nickname }
      } catch { /* optional */ }
      saveAuth(a)
      pendingLogin = null
      appendLog({ ts: new Date().toISOString(), event: 'login', uid: a.uid, nickname: a.nickname })
      sendJson(res, 200, { status: 'ok', uid: a.uid, nickname: a.nickname })
      return
    }
    sendJson(res, 404, { error: { message: `no route: ${req.method} ${url}` } })
  } catch (e) {
    try { sendJson(res, 500, { error: { message: String(e?.message ?? e) } }) } catch { /* socket gone */ }
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  cleanOldLogs()
  loadSpend()

  // DSH tool integration: lets the agent answer "切换账号 / 查余额" in chat.
  // Registered only when the dsh-tools package is resolvable (always true for
  // bundle installs; loose-directory installs fall back to the profile's
  // node_modules).
  registerTools(ctx).catch(() => { /* tools are optional */ })

  // refresh the model catalog, the account whitelist and the DSH provider
  // declaration hourly and on startup
  const catalogTimer = setInterval(() => { refreshProvider().catch(() => {}) }, 3600_000)
  catalogTimer.unref?.()
  refreshProvider().catch(() => {})

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
        res.end(JSON.stringify({ plugin: name, ok: true, mode: CONFIG.mode, realm: CONFIG.realm, workbuddyIpc: wbipcOk, ipcConfigDir: wbipcConfigDir(), ipcPinned: wbipcPinned(), tool: toolStatus, provider: providerSync, catalogFetchedAt: catalog.fetchedAt, pickerSize: catalog.picker.length }))
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
        refreshProvider().catch(() => {}) // a fresh account may see a different whitelist
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

      if (req.method === 'POST' && url === '/config/realm') {
        const body = await readBody(req)
        let next = ''
        try { next = String(JSON.parse(body.toString('utf8')).realm ?? '') } catch { /* invalid */ }
        if (next !== 'cn' && next !== 'global') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'realm must be "cn" or "global"' } }))
          return
        }
        const switched = await switchRealmGuarded(next)
        if (!switched.ok) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: switched.error }, realm: CONFIG.realm }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, realm: switched.realm, mode: CONFIG.mode, warnings: switched.warnings, provider: switched.provider }))
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
          data: exposedModels().map((m) => ({ id: m.id, object: 'model', owned_by: 'workbuddy' })),
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

      // An id we do not know has no price estimate, so forwarding it would slip
      // past perRequestCreditBudget — and router tiers are hidden on purpose.
      if (catalog.picker.length && !catalog.picker.includes(body.model)) {
        appendLog({ ts: new Date().toISOString(), event: 'unknown_model', model: body.model, realm: CONFIG.realm })
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: `unknown model ${JSON.stringify(body.model ?? null)} for realm ${CONFIG.realm}`,
            hint: `this realm currently serves ${catalog.picker.length} models; see GET /v1/models`,
          },
        }))
        return
      }

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

      // per-request runaway guard: estimate this call's cost from payload
      // size and the model's current effective multiplier
      const perReq = CONFIG.perRequestCreditBudget
      if (perReq > 0) {
        const ep = effectivePrice(body.model)
        if (ep && ep.effective != null) {
          const estTokens = Math.ceil(logCtx.msgChars / 3)
          const estCredits = Math.round(estTokens / 1000 * ep.effective * 10) / 10
          if (estCredits > perReq) {
            appendLog({ ts: new Date().toISOString(), event: 'per_request_blocked', model: body.model, estCredits, estTokens })
            res.writeHead(429, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              error: {
                message: `estimated cost ~${estCredits} credits exceeds perRequestCreditBudget (${perReq})`,
                hint: '上下文过大（疑似 agent 循环）。提高 config.json 的 perRequestCreditBudget（0 = 不限制）或缩短上下文',
              },
            }))
            return
          }
        }
      }

      // ---- direct mode: real streaming passthrough ----
      if (CONFIG.mode === 'direct') {
        const upstreamBody = { ...body, stream: true, stream_options: { include_usage: true } }
        try {
          if (body.stream === true) {
            await direct.chat(JSON.stringify(upstreamBody), res, req, logCtx)
          } else {
            const r = await direct.chatCollected(JSON.stringify(upstreamBody), req, logCtx)
            if (!res.headersSent) {
              res.writeHead(r.status, { 'content-type': 'application/json' })
              res.end(r.status === 200 && r.isSse
                ? JSON.stringify(foldSseToCompletion(r.chunks, r.usage, r.model))
                : r.text)
            }
          }
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

  ctx.inject?.(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: WEB_PREFIX,
      handler: webHandler,
    }), 'workbuddy-bridge: /workbuddy 路由')
  })

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

let toolStatus = { registered: false, reason: 'not-attempted' }

async function registerTools(ctx) {
  let defineTool
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch {
    // loose-directory install: fall back to the profile's node_modules
    try {
      ({ defineTool } = await import(pathToFileURL(path.join(os.homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href))
    } catch (e) {
      toolStatus = { registered: false, reason: `dsh-tools import failed: ${e?.message ?? e}` }
      appendLog({ ts: new Date().toISOString(), event: 'tools_failed', reason: toolStatus.reason })
      return
    }
  }
  if (typeof defineTool !== 'function') {
    toolStatus = { registered: false, reason: 'defineTool is not a function' }
    appendLog({ ts: new Date().toISOString(), event: 'tools_failed', reason: toolStatus.reason })
    return
  }
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    toolStatus = { registered: false, reason: `ctx.tools unavailable (typeof=${typeof ctx?.tools}, hasRegister=${typeof ctx?.tools?.register})` }
    appendLog({ ts: new Date().toISOString(), event: 'tools_failed', reason: toolStatus.reason })
    return
  }

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
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
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
  toolStatus = { registered: true, reason: 'ok' }
  appendLog({ ts: new Date().toISOString(), event: 'tools_registered', tool: 'workbuddy_account' })
}
