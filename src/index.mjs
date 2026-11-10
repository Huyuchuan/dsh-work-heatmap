/**
 * dsh-work-heatmap — GitHub 风格「工作热力图」插件（宿主半侧）
 *
 * 职责：
 *  1. 扫描 $DSH_HOME/sessions 下的会话日志（*.jsonl / *.jsonl.zstd），按天聚合
 *     Agent 步数（step/end）、工具调用（tool/call）、用户提示（user/message + inbox/spliced）；
 *  2. 结果按文件 (mtime, size) 增量缓存到 $DSH_HOME/heatmap/cache.json，
 *     汇总写入 $DSH_HOME/heatmap/summary.json，避免每次全量解压 200MB+ 日志；
 *  3. 通过 webServer 暴露 GET /api/dsh-work-heatmap/summary 给浏览器端渲染。
 *
 * 设计约束：
 *  - 解析在后台进行，每次让出事件循环，绝不阻塞宿主启动；
 *  - 任何异常都只记录告警，不影响 DSH 启动（fail-safe）；
 *  - 只读会话日志，不写任何 Session 数据。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const NAME = 'dsh-work-heatmap'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(DSH_HOME, 'sessions')
const DATA_DIR = join(DSH_HOME, 'heatmap')
const CACHE_PATH = join(DATA_DIR, 'cache.json')
const SUMMARY_PATH = join(DATA_DIR, 'summary.json')

const CACHE_VERSION = 3
const MAX_DAYS = 400 // 汇总保留天数上限
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时
const FORCE_THROTTLE_MS = 60 * 1000 // 客户端强制刷新最小间隔

/** 本地日期键 YYYY-MM-DD */
function dayKey(ms) {
  const d = new Date(ms)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`
}

function readJsonSafe(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, path)
  } catch (err) {
    console.warn(`[${NAME}] 写入 ${path} 失败：${err && err.message}`)
  }
}

/** 递归列出会话日志文件（最多 3 层，避免误扫巨大目录） */
function listSessionFiles() {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of names) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full, depth + 1)
      } else if (ent.isFile() && /\.jsonl(\.zstd)?$/.test(ent.name)) {
        out.push(full)
      }
    }
  }
  walk(SESSIONS_DIR, 0)
  return out
}

const yieldTick = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------------------
// Zstandard 多帧解码
//
// DSH 的会话日志是「追加式多帧容器」：每个事件批次都是一个独立的 zstd 帧
// （单个 5MB 日志里可能有 2000+ 帧）。Node 的 zstdDecompressSync 只解第一帧，
// 因此这里按帧头结构切分后逐帧解压（与 dsh-session-persistence-jsonl 的
// scanZstdFrames 同构实现）。
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 0xfd2fb528

/** 按 zstd 帧头结构切分缓冲区；结构不完整时返回已识别帧并标记 torn */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, torn: true }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, torn: true }
    offset += 4
    if (offset === buffer.length) return { frames, torn: true }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, torn: true }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, torn: true }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, torn: true }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, torn: true }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, torn: true }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, torn: true }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 解出所有完整帧的明文（跳过损坏/未完成的尾帧，不影响历史统计） */
function decodeZstdFrames(buffer) {
  const { frames } = scanZstdFrames(buffer)
  const parts = []
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // 单帧损坏：跳过该帧，保留其余数据
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 解析单个会话日志文件，返回 { mtimeMs, size, days, sessionId, depth }。
 * days: { 'YYYY-MM-DD': [steps, calls, prompts, tokens] }
 */
async function scanFile(path) {
  const st = statSync(path)
  const entry = { mtimeMs: st.mtimeMs, size: st.size, days: {}, sid: basename(dirname(path)), depth: 0 }

  let text
  try {
    const buf = readFileSync(path)
    text = path.endsWith('.zstd') ? decodeZstdFrames(buf) : buf.toString('utf8')
  } catch (err) {
    console.warn(`[${NAME}] 解压失败，跳过 ${path}：${err && err.message}`)
    entry.broken = true
    entry.days = {}
    return entry
  }

  const days = entry.days
  const bump = (ms, idx, amount) => {
    if (!Number.isFinite(ms) || ms <= 0) return
    const key = dayKey(ms)
    const cell = days[key] || (days[key] = [0, 0, 0, 0])
    cell[idx] += amount === undefined ? 1 : amount
  }

  let offset = 0
  const len = text.length
  while (offset < len) {
    let nl = text.indexOf('\n', offset)
    if (nl === -1) nl = len
    const line = text.slice(offset, nl)
    offset = nl + 1
    if (line.length < 12 || line.charCodeAt(0) !== 123 /* { */) continue

    // 先用子串判断事件类型，避免对整行做 JSON.parse（日志里 90% 是无关事件）
    let kind = -1
    if (line.includes('"type":"step/end"')) kind = 0
    else if (line.includes('"type":"tool/call"')) kind = 1
    else if (line.includes('"type":"user/message"') || line.includes('"type":"agent/inbox/spliced"')) kind = 2
    else if (line.includes('"type":"assistant/message"')) kind = 3
    else if (line.includes('"type":"session"')) {
      // 会话头：记录委派深度，用于区分主会话与子代理会话
      try {
        const ev = JSON.parse(line)
        if (typeof ev.delegationDepth === 'number') entry.depth = ev.delegationDepth
      } catch { /* 忽略坏行 */ }
      continue
    } else {
      continue
    }

    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (kind === 3) {
      // 每次模型回应带一份用量：totalTokens 含输出、输入与缓存读取
      const usage = ev.type === 'assistant/message' && ev.data ? ev.data.usage : null
      const total = usage ? Number(usage.totalTokens) : 0
      if (Number.isFinite(total) && total > 0) bump(ev.time, 3, total)
      continue
    }
    bump(ev.time, kind)
  }

  return entry
}

/** 由文件缓存合并出按天汇总 */
function buildSummary(files, meta) {
  const dayMap = new Map() // date -> { steps, calls, prompts, tokens, sessions:Set }
  const workspaces = new Set()
  let sessionCount = 0

  for (const [path, entry] of Object.entries(files)) {
    if (!entry || !entry.days) continue
    sessionCount += 1
    // workspace 目录名形如 --Users-satanachia-WorkProject-a53334--
    const rel = path.startsWith(SESSIONS_DIR) ? path.slice(SESSIONS_DIR.length + 1) : path
    const ws = rel.split('/')[0]
    if (ws) workspaces.add(ws)
    for (const [date, cell] of Object.entries(entry.days)) {
      let agg = dayMap.get(date)
      if (!agg) {
        agg = { steps: 0, calls: 0, prompts: 0, tokens: 0, sessions: new Set() }
        dayMap.set(date, agg)
      }
      agg.steps += cell[0] || 0
      agg.calls += cell[1] || 0
      agg.prompts += cell[2] || 0
      agg.tokens += cell[3] || 0
      if ((cell[0] || 0) + (cell[1] || 0) + (cell[2] || 0) + (cell[3] || 0) > 0) agg.sessions.add(entry.sid)
    }
  }

  // 行格式固定为 [date, steps, calls, prompts, sessions, tokens]，末尾追加是为兼容旧前端
  const days = [...dayMap.entries()]
    .map(([date, a]) => [date, a.steps, a.calls, a.prompts, a.sessions.size, a.tokens])
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .slice(-MAX_DAYS)

  let steps = 0
  let calls = 0
  let prompts = 0
  let tokens = 0
  let activeDays = 0
  let best = { date: '', steps: 0 }
  let bestTokens = { date: '', tokens: 0 }
  for (const row of days) {
    steps += row[1]
    calls += row[2]
    prompts += row[3]
    tokens += row[5]
    if (row[1] > 0 || row[2] > 0) activeDays += 1
    if (row[1] > best.steps) best = { date: row[0], steps: row[1] }
    if (row[5] > bestTokens.tokens) bestTokens = { date: row[0], tokens: row[5] }
  }

  return {
    generatedAt: Date.now(),
    days,
    totals: { steps, calls, prompts, tokens, activeDays, sessions: sessionCount, workspaces: workspaces.size },
    best,
    bestTokens,
    scannedFiles: Object.keys(files).length,
    ...meta,
  }
}

export const name = NAME

export const inject = ['webServer']

export function apply(ctx) {
  let cache = readJsonSafe(CACHE_PATH, null)
  if (!cache || cache.version !== CACHE_VERSION || typeof cache.files !== 'object') {
    cache = { version: CACHE_VERSION, files: {} }
  }

  let summary = readJsonSafe(SUMMARY_PATH, null)
  let scanning = false
  let lastScanAt = summary ? summary.generatedAt || 0 : 0
  let lastForceAt = 0
  let disposer = null

  const refresh = async (force) => {
    if (scanning) return
    scanning = true
    try {
      const list = listSessionFiles()
      const next = {}
      const changed = []
      for (const file of list) {
        let st
        try {
          st = statSync(file)
        } catch {
          continue
        }
        const prev = cache.files[file]
        if (!force && prev && !prev.broken && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          next[file] = prev
        } else {
          changed.push(file)
        }
      }

      for (const file of changed) {
        try {
          next[file] = await scanFile(file)
        } catch (err) {
          console.warn(`[${NAME}] 解析失败，跳过 ${file}：${err && err.message}`)
        }
        await yieldTick()
      }

      cache = { version: CACHE_VERSION, files: next }
      summary = buildSummary(next)
      lastScanAt = summary.generatedAt
      writeJsonAtomic(CACHE_PATH, cache)
      writeJsonAtomic(SUMMARY_PATH, summary)
    } catch (err) {
      console.warn(`[${NAME}] 扫描失败：${err && err.message}`)
    } finally {
      scanning = false
    }
  }

  const emptyPayload = () => ({
    generatedAt: 0,
    days: [],
    totals: { steps: 0, calls: 0, prompts: 0, activeDays: 0, sessions: 0, workspaces: 0 },
    best: { date: '', steps: 0 },
    scannedFiles: 0,
  })

  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    disposer = webServer.register({
      kind: 'exact',
      path: '/api/dsh-work-heatmap/summary',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        try {
          const url = new URL(req.url, 'http://localhost')
          const now = Date.now()
          // 汇总为空（首次安装 / 缓存损坏）时不受 6 小时间隔限制，立即重扫
          const blank = !summary || !Array.isArray(summary.days) || summary.days.length === 0
          if (url.searchParams.get('refresh') === '1' && now - lastForceAt > FORCE_THROTTLE_MS) {
            lastForceAt = now
            void refresh(true)
          } else if (!scanning && (blank || now - lastScanAt > REFRESH_INTERVAL_MS)) {
            void refresh(false)
          }
          const body = JSON.stringify({ ...(summary || emptyPayload()), scanning })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          if (req.method === 'HEAD') res.end()
          else res.end(body)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String((err && err.message) || err) }))
        }
      },
    })
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try {
          if (typeof disposer === 'function') disposer()
        } catch { /* 忽略清理异常 */ }
      })
    }
  } else {
    console.warn(`[${NAME}] webServer 不可用，数据接口未注册`)
  }

  // 启动后延迟扫描：让宿主先把 UI 拉起来，再在后台折叠日志
  const timer = setTimeout(() => {
    const now = Date.now()
    const blank = !summary || !Array.isArray(summary.days) || summary.days.length === 0
    if (blank || now - lastScanAt > REFRESH_INTERVAL_MS) void refresh(false)
  }, 2500)
  timer.unref?.()

  // 常驻节拍：跨天后自动重算（默认 6 小时一次，命中缓存时几乎零成本）
  const ticker = setInterval(() => {
    if (!scanning && Date.now() - lastScanAt > REFRESH_INTERVAL_MS) void refresh(false)
  }, 30 * 60 * 1000)
  ticker.unref?.()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      clearTimeout(timer)
      clearInterval(ticker)
    })
  }
}

export default { name, inject, apply }
