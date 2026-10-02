// OpenCode provider plugin for the MiniMax Code subscription (provider id: mcode).
//
// MiniMax Code (mcode) serves its plan's models through an Anthropic Messages
// gateway:
//
//   POST https://agent.minimax.cn/mavis/api/v1/llm/v1/messages      (cn)
//   POST https://agent.minimax.io/mavis/api/v1/llm/v1/messages      (en)
//
// authenticated with the account's OAuth access token
// (Authorization: Bearer mmoat_…). The access token is short-lived (~1 h) and
// is renewed through MiniMax's account OAuth endpoint:
//
//   POST https://account.minimax.cn/oauth2/token    (cn)
//   POST https://account.minimax.io/oauth2/token    (en)
//   grant_type=refresh_token, refresh_token=mmort_…, client_id=mcode-public,
//   scope=agent.default, audience=agent-backend
//
// Two sign-in methods are offered:
//
//  1. "MiniMax Code 桌面端登录" — reuses the account the MiniMax Code desktop
//     app is signed in to. Its OAuth record is read from
//     ~/.minimax/auth/prod/<region>/mcode-public/auth.json each time. When the
//     access token runs short the plugin refreshes it and writes the renewed
//     pair back in the app's own format, so the desktop app and this plugin
//     never drift apart.
//
//  2. "MiniMax 账号（网页登录）" — the OAuth device flow against
//     account.minimax.cn: a code challenge (S256) is posted to
//     /oauth2/device/code, magpie opens the verification page (which carries
//     the one-time user code), and /oauth2/token is polled with the
//     device_code until the user finishes authorizing in the browser. The
//     server answers "authorization_pending" (HTTP 400) while the user is
//     still on the page; only a real error ends the wait early. Tokens from
//     this method are kept in magpie's own sign-in store; the desktop file
//     is never touched.

import { randomBytes, createHash } from "node:crypto"
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CLIENT_ID = "mcode-public"
const SCOPE = "agent.default"
const AUDIENCE = "agent-backend"
const EARLY_MS = 5 * 60 * 1000 // refresh when the access token has less than this left
const SIGN_IN_MS = 5 * 60 * 1000

const REGIONS = ["cn", "en"]
const originOf = (region) =>
  region === "en" ? "https://account.minimax.io" : "https://account.minimax.cn"
const llmBaseOf = (region) =>
  region === "en"
    ? "https://agent.minimax.io/mavis/api/v1/llm/v1"
    : "https://agent.minimax.cn/mavis/api/v1/llm/v1"

const NPM = "@ai-sdk/anthropic"

// Fallback list, used only when ~/.minimax/config.yaml cannot be read: the
// native MiniMax models, with their limits.
const FALLBACK_MODELS = [
  { id: "MiniMax-M3", name: "MiniMax-M3", context: 512000, output: 128000, reasoning: true, tool: true, image: true },
  { id: "MiniMax-M3.1-Flash-Preview", name: "MiniMax-M3.1-Flash-Preview", context: 512000, output: 128000, reasoning: true, tool: true, image: true },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax-M2.7-highspeed", context: 200000, output: 128000, reasoning: true, tool: true, image: false },
  { id: "MiniMax-M2.7", name: "MiniMax-M2.7", context: 200000, output: 128000, reasoning: true, tool: true, image: false },
]

// ---- the desktop sign-in ---------------------------------------------------

// authFile is where MiniMax Code keeps the OAuth record for region.
const authFile = (region) =>
  join(homedir(), ".minimax", "auth", "prod", region, "mcode-public", "auth.json")

// readDesktop is the desktop app's sign-in as it keeps it now, or null for
// none. The record key in the file contains a NUL byte; it is preserved
// verbatim when writing back.
function readDesktop(region) {
  try {
    const doc = JSON.parse(readFileSync(authFile(region), "utf8"))
    const rec = Object.values(doc?.records ?? {})[0]
    if (!rec || typeof rec.accessToken !== "string" || !rec.accessToken) return null
    if (typeof rec.refreshToken !== "string" || !rec.refreshToken) return null
    if (typeof rec.expiresAtMs !== "number" || !Number.isFinite(rec.expiresAtMs)) return null
    return {
      region,
      access: rec.accessToken,
      refresh: rec.refreshToken,
      expiresAtMs: rec.expiresAtMs,
      generation: Number.isInteger(rec.generation) ? rec.generation : 0,
      loginEpoch: typeof rec.loginEpoch === "string" ? rec.loginEpoch : "",
    }
  } catch {
    return null
  }
}

function readDesktopAny() {
  for (const region of REGIONS) {
    const d = readDesktop(region)
    if (d) return d
  }
  return null
}

// atomicWrite mirrors the app's own writer: a private temp file in the same
// directory, then rename over the target.
function atomicWrite(path, text) {
  const tmp = path + ".tmp-" + Date.now() + "-" + Math.floor(Math.random() * 1e6)
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {}
  renameSync(tmp, path)
}

// writeBack stores a refreshed pair in the desktop app's files, in the app's
// own shape (credentialFromGrant + authenticatedState): a new generation,
// atomic writes, credential first then state. It is optimistic — if the file
// moved on to a newer generation since it was read (the app refreshed in the
// meantime) the write is skipped and { ok: false } comes back, so the caller
// re-reads and uses the app's token.
function writeBack(before, grant) {
  const dir = join(homedir(), ".minimax", "auth", "prod", before.region, "mcode-public")
  const credPath = join(dir, "auth.json")
  const statePath = join(dir, "auth-state.json")
  let doc
  try {
    doc = JSON.parse(readFileSync(credPath, "utf8"))
  } catch {
    return { ok: false }
  }
  const key = Object.keys(doc?.records ?? {})[0]
  const cur = key && doc.records[key]
  if (!cur || !Number.isInteger(cur.generation) || cur.generation !== before.generation) {
    return { ok: false } // the app (or another owner) moved first
  }
  const now = Date.now()
  const expiresAtMs = now + grant.expiresInSec * 1000
  const generation = cur.generation + 1
  doc.records[key] = {
    ...cur,
    accessToken: grant.access,
    refreshToken: grant.refresh,
    expiresAtMs,
    generation,
  }
  atomicWrite(credPath, JSON.stringify(doc, null, 2) + "\n")
  let state = null
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch {}
  if (state && typeof state === "object" && !Array.isArray(state)) {
    state.status = "authenticated"
    state.generation = generation
    state.expiresAtMs = expiresAtMs
    try {
      atomicWrite(statePath, JSON.stringify(state, null, 2) + "\n")
    } catch {
      // the credential is what matters; a state write failure only costs the
      // app one extra refresh later
    }
  }
  return { ok: true, expiresAtMs, generation }
}

// ---- MiniMax account OAuth --------------------------------------------------

// postForm is the account endpoint's form post, as mcode's oauth-client does
// it (application/x-www-form-urlencoded, JSON answers).
async function postForm(region, path, values) {
  const res = await fetch(originOf(region) + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.json().catch(() => null)
  const err = body && typeof body.error === "string" ? body.error : ""
  return { ok: res.ok && !err, status: res.status, body: body ?? {}, error: err }
}

// grant parses an account token answer, keeping the old refresh token when the
// server sends none.
function grant(body, previousRefresh) {
  const access = typeof body.access_token === "string" ? body.access_token : ""
  const refresh =
    typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : previousRefresh
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 3600
  if (!access || expiresIn <= 0)
    throw new Error("MiniMax 令牌接口返回了不完整的令牌")
  return { access, refresh: refresh || "", expiresInSec: expiresIn }
}

// refresh renews an access token the way the desktop app renews its own.
async function refresh(region, refreshToken) {
  const r = await postForm(region, "/oauth2/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPE,
    audience: AUDIENCE,
  })
  if (!r.ok || !r.body?.access_token)
    throw new Error(
      "MiniMax 令牌刷新失败：" + (r.error || "HTTP " + r.status)
    )
  return grant(r.body, refreshToken)
}

// decodeClaims pulls the subject out of an access token when it is a JWT.
function decodeClaims(token) {
  const parts = String(token).split(".")
  if (parts.length !== 3 || !parts[1]) return {}
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) ?? {}
  } catch {
    return {}
  }
}

// fetchAccountInfo returns the MiniMax account's display name (and subject_id)
// from the account API, so both desktop and browser sign-ins can share the same
// accountId and magpie merges them into one. Returns null on failure.
async function fetchAccountInfo(token, region) {
  try {
    const res = await fetch("https://api.minimax." + (region === "en" ? "io" : "cn") + "/backend/account", {
      method: "GET",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const body = await res.json()
    const info = body?.account_info
    if (!info) return null
    const name = typeof info.name === "string" && info.name ? info.name : ""
    const phone = typeof info.phone === "string" ? info.phone : ""
    const subjectId = typeof info.subject_id === "string" ? info.subject_id : ""
    return { name, phone, subjectId }
  } catch {
    return null
  }
}

// ---- signing in ---------------------------------------------------------------

// desktopSignIn uses the account MiniMax Code is signed in to: nothing is
// copied (a copied refresh token would be the app's and the plugin's both),
// its file is read each time, as the app keeps it.
function desktopSignIn() {
  return {
    url: "",
    instructions: "沿用 MiniMax Code 桌面端当前登录的账号（读取其 ~/.minimax 下的 OAuth 记录）。",
    method: "auto",
    async callback() {
      const d = readDesktopAny()
      if (!d)
        return {
          type: "failed",
          error: "本机 MiniMax Code 未登录（未找到 OAuth 记录），请先在 MiniMax Code 桌面端登录",
        }
      // Resolve the real account name so both desktop and browser sign-ins
      // share the same accountId and magpie merges them into one entry.
      const info = await fetchAccountInfo(d.access, d.region)
      const accountId = info?.name || info?.phone || ("MiniMax Code (" + d.region + ")")
      return {
        type: "success",
        refresh: "",
        access: "",
        expires: 0,
        source: "mcode-desktop",
        accountId,
        ...(info?.subjectId ? { subjectId: info.subjectId } : {}),
      }
    },
  }
}

// browserSignIn is the OAuth device flow, as mcode's client runs it: a code
// challenge (S256) is posted to /oauth2/device/code and the verification URL
// is handed back up front, so magpie opens the browser itself. The user signs
// in on that page (the one-time user code is already in the URL); the
// callback then polls /oauth2/token with the device_code until the grant
// arrives. The server answers "authorization_pending" (HTTP 400) while the
// user is still on the page; only a real error ends the wait early. Tokens
// from this method are kept in magpie's own sign-in store; the desktop file
// is never touched.
async function browserSignIn() {
  const region = "cn"
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let dev
  try {
    dev = await postForm(region, "/oauth2/device/code", {
      client_id: CLIENT_ID,
      scope: SCOPE,
      audience: AUDIENCE,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
  } catch (e) {
    dev = { ok: false, status: 0, body: {}, error: String(e?.message ?? e) }
  }
  const url =
    typeof dev.body?.verification_uri_complete === "string" && dev.body.verification_uri_complete
      ? dev.body.verification_uri_complete
      : (typeof dev.body?.verification_uri === "string"
          ? dev.body.verification_uri
          : "https://account.minimax.cn/oauth-authorize") +
        "?user_code=" + encodeURIComponent(dev.body?.user_code ?? "")
  if (!dev.ok || !dev.body?.device_code || !dev.body?.user_code)
    return {
      url: "",
      instructions: "",
      method: "auto",
      async callback() {
        return {
          type: "failed",
          error: "MiniMax 没有返回设备登录信息：" + (dev.error || "HTTP " + dev.status),
        }
      },
    }
  const expiresInSec = typeof dev.body.expires_in === "number" ? dev.body.expires_in : 600
  const deadline = Date.now() + Math.min(expiresInSec, SIGN_IN_MS / 1000) * 1000
  let intervalMs =
    (typeof dev.body.interval === "number" ? dev.body.interval : 5) * 1000
  return {
    url,
    instructions: "已打开 MiniMax 登录页，请在浏览器里完成登录；登录成功后这里会自动完成，无需其他操作。",
    method: "auto",
    async callback() {
      try {
        while (Date.now() < deadline) {
          const r = await postForm(region, "/oauth2/token", {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: dev.body.device_code,
            client_id: CLIENT_ID,
            code_verifier: verifier,
          })
          const status = r.body?.status || r.body?.error || ""
          if (r.ok && r.body?.access_token) {
            const g = grant(r.body, "")
            // Resolve the real account name so this sign-in merges with the
            // desktop one in magpie's account list.
            const info = await fetchAccountInfo(g.access, region)
            const accountId = info?.name || info?.phone || ("MiniMax 账号 (" + region + ")")
            return {
              type: "success",
              access: g.access,
              refresh: g.refresh,
              expires: Date.now() + g.expiresInSec * 1000,
              region,
              accountId,
              ...(info?.subjectId ? { subjectId: info.subjectId } : {}),
            }
          }
          if (status === "authorization_pending") {
            // 用户还在登录页上 —— 继续轮询
          } else if (status === "slow_down") {
            intervalMs += 5000
          } else if (status === "denied" || status === "access_denied") {
            return { type: "failed", error: "MiniMax 登录被拒绝" }
          } else if (r.error) {
            // 真实错误（expired_token、invalid_request 等）：提前结束等待
            return {
              type: "failed",
              error: "MiniMax 登录失败：" + (r.body?.error_description || r.error),
            }
          }
          if (Date.now() + intervalMs > deadline) break
          await sleep(intervalMs)
        }
        return {
          type: "failed",
          error:
            "等待登录超时（登录码 " + dev.body.user_code +
            " 已过期）：请再点一次，并在浏览器里完成登录",
        }
      } catch (e) {
        return { type: "failed", error: "MiniMax 登录失败：" + (e?.message ?? String(e)) }
      }
    },
  }
}

// ---- tokens -------------------------------------------------------------------

// held keeps sign-ins this plugin refreshed for a magpie-held (browser)
// sign-in, per account; the desktop sign-in always reads the app's file.
const held = new Map()

// current is the fresh token a stored sign-in names: the desktop app's, read
// where the app keeps it and refreshed (and written back) when it runs short,
// or one kept here. opts.force skips the freshness check (a 401 recovery).
async function current(client, auth, opts = {}) {
  const desktop =
    auth?.source === "mcode-desktop" || (!auth?.access && !held.has(auth?.accountId || ""))
  if (desktop) {
    const d = readDesktopAny()
    if (!d) throw new Error("本机 MiniMax Code 未登录（未找到 OAuth 记录）")
    if (!opts.force && d.expiresAtMs - Date.now() > EARLY_MS) return d
    try {
      const g = await refresh(d.region, d.refresh)
      const wb = writeBack(d, g)
      if (wb.ok)
        return { region: d.region, access: g.access, refresh: g.refresh, expiresAtMs: wb.expiresAtMs, generation: wb.generation }
      // the app refreshed in the meantime: use its token
      const d2 = readDesktopAny()
      if (d2 && d2.expiresAtMs - Date.now() > 0) return d2
      throw new Error("MiniMax Code 令牌已过期且桌面端刚刷新过，重试即可使用桌面端的新令牌")
    } catch (e) {
      if (d.expiresAtMs - Date.now() > 0) return d // still valid for a while
      throw new Error(
        "MiniMax Code 的登录已过期且自动刷新失败（" + (e?.message ?? e) + "）— 请在 MiniMax Code 桌面端重新登录"
      )
    }
  }
  const key = auth?.accountId || "mcode"
  const h = held.get(key)
  const a = h && h.expires > (auth?.expires ?? 0) ? h : auth
  if (!a?.access) throw new Error("MiniMax Code 未登录")
  const region = a.region || "cn"
  if (!opts.force && a.expires - Date.now() > EARLY_MS) return a
  const g = await refresh(region, a.refresh)
  const next = { ...a, access: g.access, refresh: g.refresh, expires: Date.now() + g.expiresInSec * 1000, region }
  held.set(key, next)
  try {
    await client?.auth?.set?.({ path: { id: "mcode" }, body: next })
  } catch {
    // magpie will re-sign in if it cannot persist; the in-memory copy works
  }
  return next
}

// ---- requests -------------------------------------------------------------------

// normalize points a request at the one Messages path the gateway actually
// routes (…/mavis/api/v1/llm/v1/messages), for the region the sign-in is on,
// whatever base URL the caller was given.
function normalizeUrl(u, region) {
  try {
    const url = new URL(u)
    if (!/(^|\.)minimax\.(cn|io)$/.test(url.hostname)) return u
    const base = llmBaseOf(region)
    // relative, so it resolves against the base's own path (…/llm → …/llm/v1/messages)
    const rel = /count_tokens$/.test(url.pathname)
      ? "v1/messages/count_tokens"
      : "v1/messages"
    const target = new URL(rel, base)
    url.protocol = target.protocol
    url.host = target.host
    url.pathname = target.pathname
    url.search = ""
    return url.toString()
  } catch {
    return u
  }
}

// ---- models -------------------------------------------------------------------

// readModels reads the model table MiniMax Code keeps in its own config
// (~/.minimax/config.yaml, provider.minimax.models): the plan's models with
// their windows and limits. A focused line parser, tolerant of the file's
// other sections.
function readModels() {
  let text
  try {
    text = readFileSync(join(homedir(), ".minimax", "config.yaml"), "utf8")
  } catch {
    return []
  }
  const out = []
  let inProvider = false
  let provider = null
  let inModels = false
  let cur = null
  const push = () => {
    if (cur && cur.id) out.push(cur)
    cur = null
  }
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim() || ln.trim().startsWith("#")) continue
    const indent = ln.length - ln.trimStart().length
    const key = ln.trim()
    if (indent === 0) {
      push()
      inProvider = key === "provider:"
      provider = null
      inModels = false
      continue
    }
    if (inProvider && indent === 2 && key.endsWith(":")) {
      push()
      provider = key.slice(0, -1)
      inModels = false
      continue
    }
    if (provider === "minimax" && indent === 4 && key === "models:") {
      push()
      inModels = true
      continue
    }
    if (inModels && indent === 6 && key.endsWith(":") && !key.startsWith("-")) {
      push()
      const id = key.slice(0, -1).replace(/^[\'"]|['"]$/g, "")
      cur = {
        id,
        name: id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id,
        context: 0,
        output: 0,
        reasoning: false,
        tool: true,
        image: false,
      }
      continue
    }
    if (inModels && cur && key.includes(":")) {
      const k = key.split(":")[0].trim()
      const v = key.slice(key.indexOf(":") + 1).trim().replace(/^[\'"]|['"]$/g, "")
      if (indent === 8) {
        if (k === "name" && v) cur.name = v
        else if (k === "reasoning") cur.reasoning = v === "true"
        else if (k === "tool_call") cur.tool = v === "true"
        else if (k === "attachment") cur.image = v === "true"
      } else if (indent === 10) {
        if (k === "context" && /^\d+$/.test(v)) cur.context = +v
        else if (k === "output" && /^\d+$/.test(v)) cur.output = +v
      }
    }
    if (inModels && (indent === 2 || (indent === 4 && key !== "models:"))) {
      push()
      inModels = false
    }
  }
  push()
  return out
}

function variants(efforts) {
  return Object.fromEntries((efforts ?? []).map((e) => [e, { reasoningEffort: e }]))
}

function modelOf(m) {
  const id = m.id
  return {
    id,
    providerID: "mcode",
    name: m.name || id,
    api: { id, url: llmBaseOf("cn"), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context || 0, output: m.output || 0 },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning,
      attachment: m.image,
      toolcall: m.tool,
      input: { text: true, image: m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: variants([]),
    free: false,
  }
}

function makePlugin() {
  return async ({ client }) => ({
    config: async (config) => {
      config.provider ??= {}
      const p = (config.provider.mcode ??= {})
      p.name ??= "MiniMax Code"
      p.npm ??= NPM
      p.api ??= llmBaseOf("cn")
      p.models ??= {}
      for (const m of FALLBACK_MODELS) p.models[m.id] ??= modelOf(m)
    },
    provider: {
      id: "mcode",
      async models(provider) {
        const ms = readModels()
        if (ms.length) return Object.fromEntries(ms.map((m) => [m.id, modelOf(m)]))
        return provider.models
      },
    },
    auth: {
      provider: "mcode",
      icon: "data:image/png;base64,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",
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        return {
          baseURL: llmBaseOf("cn"),
          apiKey: "",
          async fetch(input, init) {
            const req = input instanceof Request ? input : null
            const a = await current(client, auth)
            const rawUrl = req ? req.url : String(input)
            const url = normalizeUrl(rawUrl, a.region)
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            headers.delete("content-length")
            let body = init?.body
            if (body === undefined && req) body = await req.clone().text()
            const doFetch = (token) => {
              const h = new Headers(headers)
              h.set("authorization", "Bearer " + token)
              return fetch(url, {
                ...(init ?? {}),
                method: init?.method ?? req?.method ?? "POST",
                headers: h,
                body,
              })
            }
            let res = await doFetch(a.access)
            if (res.status === 401) {
              // the token was rejected server-side: renew once and retry
              try {
                const a2 = await current(client, auth, { force: true })
                if (a2.access !== a.access) res = await doFetch(a2.access)
              } catch {
                // fall through with the 401
              }
            }
            return res
          },
        }
      },
      // usage reports the account's remaining quota to magpie's account list,
      // read from MiniMax's token-plan API (the same one the desktop app uses).
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) throw new Error("mcode 未登录")
        // Resolve a fresh token (desktop's file or this account's stored one)
        const a = await current(client, auth)
        const region = a.region || "cn"
        const host = "https://api.minimax." + (region === "en" ? "io" : "cn")
        try {
          const res = await fetch(host + "/backend/account/token_plan/remains_percent", {
            method: "GET",
            headers: { Authorization: "Bearer " + a.access, Accept: "application/json" },
            signal: AbortSignal.timeout(15000),
          })
          if (!res.ok) throw new Error("HTTP " + res.status)
          const body = await res.json()
          const mr = Array.isArray(body?.model_remains) ? body.model_remains : []
          const g = mr.find((x) => x?.model_name === "general") || mr[0]
          if (!g) return { error: "未找到额度数据" }
          // Build a weekly window from the API's fields
          const usedPct = Math.max(0, Math.min(100,
            g.current_weekly_used_percent
              ? parseInt(g.current_weekly_used_percent, 10) || 0
              : (g.current_weekly_total_count > 0
                  ? Math.round((g.current_weekly_used_count / g.current_weekly_total_count) * 100)
                  : 0)
          ))
          const weeklyEnd = typeof g.weekly_end_time === "number" ? g.weekly_end_time : 0
          const weeklyStart = typeof g.weekly_start_time === "number" ? g.weekly_start_time : 0
          const span = weeklyEnd && weeklyStart ? Math.floor((weeklyEnd - weeklyStart) / 1000) : 7 * 86400
          // Also fetch account name for display
          const info = await fetchAccountInfo(a.access, region)
          return {
            plan: "MiniMax Code Token Plan",
            user: info?.name || "",
            until: weeklyEnd ? new Date(weeklyEnd).toISOString() : "",
            renew: "auto",
            windows: [{
              name: "周额度",
              used: usedPct,
              resetsAt: weeklyEnd || undefined,
              resetSecs: weeklyEnd ? Math.max(0, Math.floor((weeklyEnd - Date.now()) / 1000)) : 0,
              span,
              display: usedPct + "%",
            }],
          }
        } catch (e) {
          return { error: "额度查询失败：" + (e?.message ?? String(e)) }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "MiniMax Code 桌面端登录",
          authorize: async () => desktopSignIn(),
        },
        {
          type: "oauth",
          label: "MiniMax 账号（网页登录）",
          authorize: () => browserSignIn(),
        },
      ],
    },
  })
}

export const MCodeAuthPlugin = makePlugin()
