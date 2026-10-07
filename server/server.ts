/**
 * bloghao-demo 自托管入口（Docker / Node 单进程，业务代码零改动直接 import src/index.ts）。
 *
 * 与主仓库 docker-poc/server.ts 的关系：同一套 Node 适配层（http ↔ fetch、node:sqlite D1、
 * 磁盘图床、静态直出、cron），面向「单租户演示体验站」做了精简：
 *  - 租户固定 demo:true（DEMO_MODE=1：自动播种 / 定时重置 / 演示守卫），图片只落本地磁盘
 *  - 只登记一个租户时，任何 Host（IP 直连、localhost、反代带来的真域名）都回落到它——
 *    服务器上不用为了「用哪个域名访问」改配置
 *  - cron 含演示站重置窗口（DEMO_RESET_CRON，每 2 小时清库重灌种子数据）
 * 运行与部署见仓库 README.md / DEPLOY.md。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

import xwblog from '../src/index'
import { ensureSchema } from '../src/db'
import { DEMO_RESET_CRON } from '../src/demo-content'
import { createD1 } from './shims/d1'
import { createR2Disk } from './shims/r2disk'
// D1 的建表靠部署时的建表步骤完成，ensureSchema 只管增量补列——租户库是全新文件，
// 这里要先自己跑一遍 schema.sql（官方幂等设计，可重复执行），与演示站 src/demo.ts 的
// ensureTables 同款思路
import SCHEMA_SQL from '../schema.sql'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
/** '1'（默认）= 信任反代注入的访客 IP 头；'0' = Node 直接暴露公网，只认 socket 远端 */
const TRUST_PROXY = (process.env.TRUST_PROXY ?? '1') !== '0'
// 默认值按「打包产物在 server/dist/server.js」的层级推导：dist/../.. = 仓库根、
// dist/.. = server/；Docker 里保持同样层级，仅 TENANTS_DIR 用环境变量指到挂载卷
const PUBLIC_ROOT = path.resolve(process.env.PUBLIC_ROOT || path.resolve(__dirname, '../../public'))
const TENANTS_DIR = path.resolve(process.env.TENANTS_DIR || path.resolve(__dirname, '../data/tenants'))
const TENANTS_CONFIG = path.resolve(process.env.TENANTS_CONFIG || path.resolve(__dirname, '../tenants.json'))

interface Tenant {
  host: string
  env: Record<string, unknown>
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/

/** 读 tenants.json：{ "域名": { demo } } 平铺（demo 缺省视为 true——本仓库整个就是演示站） */
function readTenantsConfig(): Record<string, { demo?: boolean }> {
  const raw = JSON.parse(fs.readFileSync(TENANTS_CONFIG, 'utf8'))
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.tenants) {
    return raw.tenants as Record<string, { demo?: boolean }>
  }
  return raw as Record<string, { demo?: boolean }>
}

/** 初始化演示租户：域名 → 自己的 blog.db（WAL）+ 磁盘图床目录 */
async function loadTenants(): Promise<Map<string, Tenant>> {
  const tenants = readTenantsConfig()
  const map = new Map<string, Tenant>()
  for (const [host, tc] of Object.entries(tenants)) {
    if (!HOST_RE.test(host)) throw new Error(`tenants.json 里的域名不合法: ${host}`)
    const dir = path.join(TENANTS_DIR, host)
    fs.mkdirSync(dir, { recursive: true })
    const env: Record<string, unknown> = {
      DB: createD1(path.join(dir, 'blog.db')),
      IMAGES: createR2Disk(path.join(dir, 'uploads')),
      // 业务代码从不调用 ASSETS（静态资源在适配层直出），兜底防误用
      ASSETS: { fetch: async () => new Response('ASSETS binding is handled by the self-host adapter', { status: 404 }) },
      // 本仓库整个就是演示站：demo 配置项缺省即开（显式 false 可起一个空库真实租户做对照）
      DEMO_MODE: tc?.demo === false ? undefined : '1',
    }
    const db = env.DB as { exec: (sql: string) => Promise<unknown> }
    await db.exec(SCHEMA_SQL)
    await ensureSchema(env.DB as never)
    map.set(host, { host, env })
    console.log(`[tenant] ${host} 就绪（演示种子，磁盘图床）→ ${dir}`)
  }
  return map
}

/** Workers ExecutionContext 的等价物：waitUntil 的异步任务失败只记日志，不炸请求 */
const execCtx = {
  waitUntil(p: Promise<unknown>) {
    Promise.resolve(p).catch((e) => console.error('[waitUntil]', e))
  },
  passThroughOnException() {},
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

/** 静态资源直出（对齐 wrangler assets：精确文件命中才返回，其余进应用） */
function serveStatic(pathname: string, search: string): Response | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const file = path.resolve(PUBLIC_ROOT, `.${decoded}`)
  if (file !== PUBLIC_ROOT && !file.startsWith(PUBLIC_ROOT + path.sep)) return null
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  // 目录路径不带斜杠：301 补斜杠（对齐 wrangler assets 的 auto-trailing-slash）。
  // 否则 index.html 在 /admin 下被直出，页面里的相对路径资源 ./admin.css 会解析成
  // /admin.css → 404 → 后台整页空白（甲骨文服务器实测抓出）
  if (!decoded.endsWith('/') && st.isDirectory()) {
    return new Response(null, { status: 301, headers: { Location: `${decoded}/${search}` } })
  }
  const candidates = [file, path.join(file, 'index.html')]
  for (const f of candidates) {
    let fst: fs.Stats
    try {
      fst = fs.statSync(f)
    } catch {
      continue
    }
    if (!fst.isFile()) continue
    return new Response(fs.readFileSync(f), {
      headers: {
        'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=120',
      },
    })
  }
  return null
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'content-length',
  'te',
  'trailer',
])

function sendToNode(req: http.IncomingMessage, res: http.ServerResponse, appRes: Response, isHttps: boolean) {
  const headers: Record<string, string | string[]> = {}
  appRes.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value
  })
  // 会话 cookie 带 Secure：明文 http（本地冒烟 / 未挂 TLS）浏览器和 curl 都不会携带。
  // isHttps 由 resolveScheme 统一判定（CF 灵活 SSL 下 X-Forwarded-Proto 是回源段的 http，不可作数）
  const cookies = appRes.headers.getSetCookie()
  if (cookies.length) {
    headers['set-cookie'] = cookies.map((sc) =>
      isHttps ? sc : sc.split('; ').filter((p) => p !== 'Secure').join('; ')
    )
  }
  res.writeHead(appRes.status, headers)
  if (req.method === 'HEAD' || !appRes.body) {
    res.end()
    return
  }
  Readable.fromWeb(appRes.body as never).pipe(res)
}

/**
 * 浏览器侧真实 scheme。优先级：
 *  1. Origin 头（host 与请求一致时）——api.ts 的同源 CSRF 校验拿它和 c.req.url.origin 全等比较，
 *     scheme 不一致就会误判跨站（CF 灵活 SSL 实测被拒）
 *  2. CF-Visitor——Cloudflare 注入的访客侧 scheme（灵活 SSL 下也是 https，X-Forwarded-Proto 则是回源段）
 *  3. X-Forwarded-Proto（常规 TLS 反代）
 *  4. http
 */
function resolveScheme(headers: Headers, host: string): string {
  const origin = headers.get('origin')
  if (origin) {
    try {
      const o = new URL(origin)
      if (o.host === host) return o.protocol.replace(':', '')
    } catch {
      /* 非法 Origin 走兜底链 */
    }
  }
  try {
    const visitor = JSON.parse(headers.get('cf-visitor') || '{}') as { scheme?: string }
    if (visitor.scheme) return visitor.scheme
  } catch {
    /* 头损坏走兜底链 */
  }
  const xfp = (headers.get('x-forwarded-proto') || '').split(',')[0].trim()
  return xfp || 'http'
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, tenants: Map<string, Tenant>, fallback?: Tenant) {
  const started = Date.now()
  const hostHeader = req.headers.host || 'localhost'
  const host = hostHeader.split(':')[0].toLowerCase()
  const url = new URL(req.url || '/', `http://${hostHeader}`)

  // 1) 静态资源（/admin/ SPA、插件、favicon 等；public/ 里没有的路径自然落空）
  if (req.method === 'GET' || req.method === 'HEAD') {
    const hit = serveStatic(url.pathname, url.search)
    if (hit) {
      res.writeHead(hit.status, Object.fromEntries(hit.headers as never))
      if (req.method === 'HEAD') res.end()
      else res.end(Buffer.from(await hit.arrayBuffer()))
      console.log(`[http] ${req.method} ${host}${url.pathname} ${hit.status} ${Date.now() - started}ms (static)`)
      return
    }
  }

  // 2) 租户路由：只登记一个租户时任意 Host 都回落到它（IP 直连 / localhost / 反代真域名通吃）；
  //    登记多个租户则严格按 Host 匹配，未登记 404
  const tenant = tenants.get(host) ?? (tenants.size === 1 ? fallback : undefined)
  if (!tenant) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`未登记的站点域名：${host}\n请在 server/tenants.json 里登记后重启。`)
    return
  }

  // 3) 组装 fetch Request 交给 Hono 应用（环境与执行上下文按租户注入）
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key) || value === undefined) continue
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else headers.set(key, value)
  }
  // 访客 IP 可信来源：默认 TRUST_PROXY=1 信任反代注入的头（CF-Connecting-IP / X-Forwarded-For）；
  // Node 直接暴露公网时设 TRUST_PROXY=0——客户端可随意伪造上述头轮换 IP 绕过限流，
  // 此时剥掉入站头、以 socket 远端地址注入 CF-Connecting-IP（auth.ts clientIp 优先读它，业务零改动）
  if (!TRUST_PROXY) {
    headers.delete('cf-connecting-ip')
    headers.delete('x-forwarded-for')
    headers.delete('x-real-ip')
    const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
    if (remote) headers.set('cf-connecting-ip', remote)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  const proto = resolveScheme(headers, url.host)
  const appReq = new Request(`${proto}://${hostHeader}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as never) : undefined,
    duplex: 'half',
  } as RequestInit)
  const appRes = await xwblog.fetch(appReq, tenant.env as never, execCtx as never)
  sendToNode(req, res, appRes, proto === 'https')
  console.log(`[http] ${req.method} ${host}${url.pathname} ${appRes.status} ${Date.now() - started}ms`)
}

let firedBackupDay = ''
let firedDemoResetHour = ''
const CRON_TICK_MS = 60_000

/**
 * cron：与 wrangler triggers.crons 同口径——每分钟扫定时发布；
 * 北京时间 00:30（UTC 16:30）那一分钟换成备份窗口（演示站备份默认关闭，跑了也只是空过）；
 * 每两小时的第 23 分钟（UTC 语义，DEMO_RESET_CRON）清库重灌演示种子数据。
 */
function startCron(tenants: Map<string, Tenant>) {
  const timer = setInterval(async () => {
    const now = new Date()
    const backupWindow = now.getUTCHours() === 16 && now.getUTCMinutes() === 30
    const day = now.toISOString().slice(0, 10)
    if (backupWindow) {
      if (firedBackupDay === day) return // 同一天只触发一次，防 tick 漂移双发
      firedBackupDay = day
    }
    // demo 重置窗口：分钟位 23 + 偶数小时（'23 */2 * * *' 的 UTC 语义）；小时粒度记账防双发
    const resetWindow = !backupWindow && now.getUTCMinutes() === 23 && now.getUTCHours() % 2 === 0
    const hourKey = now.toISOString().slice(0, 13)
    if (resetWindow) {
      if (firedDemoResetHour === hourKey) return
      firedDemoResetHour = hourKey
    }
    const controller = {
      cron: backupWindow ? '30 16 * * *' : resetWindow ? DEMO_RESET_CRON : '* * * * *',
      scheduledTime: now.getTime(),
    }
    for (const t of tenants.values()) {
      try {
        await xwblog.scheduled(controller as never, t.env as never, execCtx as never)
      } catch (e) {
        console.error(`[cron:${t.host}]`, e)
      }
    }
  }, CRON_TICK_MS)
  timer.unref()
}

const tenants = await loadTenants()
const fallbackTenant = tenants.size === 1 ? [...tenants.values()][0] : undefined

const server = http.createServer((req, res) => {
  handle(req, res, tenants, fallbackTenant).catch((e) => {
    console.error('[server] unhandled', e)
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('服务开小差了，请稍后再试。')
  })
})

server.listen(PORT, () => {
  console.log(`\nbloghao-demo（演示体验版）已启动：http://127.0.0.1:${PORT}`)
  console.log(`  租户：${[...tenants.keys()].join('  ')}${fallbackTenant ? '（任意 Host 回落到唯一租户）' : ''}`)
  console.log(`  静态根：${PUBLIC_ROOT}`)
  console.log(`  数据根：${TENANTS_DIR}`)
  console.log(`  首次打开页面自动建表 + 播种演示数据；每 2 小时（:23）清库重灌\n`)
})

startCron(tenants)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
