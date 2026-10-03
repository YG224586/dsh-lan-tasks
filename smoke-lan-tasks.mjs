/**
 * 离线冒烟测试：不开 DSH，直接用假的 ctx 把插件跑起来，
 * 验证 HTTP 层、快照组装、SSE、鉴权、404 这些不依赖宿主的部分。
 *
 * 用法： node smoke-lan-tasks.mjs [port]
 */
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { apply } from './index.js'
import { qrMatrix, qrSvg } from './qrcode.js'

const PORT = Number(process.argv[2] || 8799)
const PANEL_PORT = PORT + 1
const TOKEN_PORT = PORT + 2
const TOKEN_PANEL_PORT = PORT + 3
const TOKEN = 's3cr3t-token-0123456789'
const HAS_WEB = !process.env.SMOKE_NO_WEB

/* ── 假 webServer：桌面面板路由注册到这里，再用真 http server 把它们跑起来 ── */

function makeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(entry) {
      routes.set(entry.path, entry)
      return () => routes.delete(entry.path)
    },
  }
}

/** 把记录下来的路由挂到一个真的 http server 上，断言走真实的 HTTP 往返。 */
function serveRoutes(routes, port) {
  const server = http.createServer((req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname
    } catch {
      /* 路径畸形按 404 处理 */
    }
    const entry = routes.get(pathname)
    if (!entry || entry.kind !== 'exact') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no route')
      return
    }
    try {
      entry.handler(req, res)
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
      } catch {
        /* 头已经发出去了 */
      }
    }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const web = makeWebServer()

/* ── 假数据：尽量贴近真实契约 ── */
const lead = { id: 'session-lead-0001' }
const mate = { id: 'session-mate-0002' }
const now = Date.now()

/* ── 假日志：手机端点进会话要读的就是这些 ── */
const IMG_BYTES = Buffer.from('89504e470d0a1a0a0000000d', 'hex')
const IMG_B64 = IMG_BYTES.toString('base64')

const leadEvents = [
  { type: 'turn/start', seq: 1, time: now - 5000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: now - 4800, data: { role: 'user', content: '帮我看下任务情况' } },
  { type: 'tool/call', seq: 3, time: now - 4600, data: { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{"command":"pnpm install","description":"装依赖"}' } },
  { type: 'tool/result', seq: 4, time: now - 4400, data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done in 3.2s' }] } } },
  { type: 'assistant/message', seq: 5, time: now - 4200, data: { message: { role: 'assistant', content: [{ type: 'text', text: '装好了，正在写手机页面。' }] } } },
  {
    type: 'user/message', seq: 6, time: now - 4000,
    data: {
      role: 'user',
      content: [
        { type: 'text', text: '参考这张图' },
        { type: 'image', attachmentId: 'att-1', mediaType: 'image/png', bytes: IMG_BYTES.length, width: 2, height: 2, name: 'shot.png' },
      ],
    },
  },
  { type: 'tool/call', seq: 7, time: now - 3800, data: { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"node -v"}' } },
  { type: 'tool/result', seq: 8, time: now - 3600, data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'c2' }, error: { code: 'E_BANG', message: '命令失败' } } },
]
const mateEvents = [
  { type: 'turn/start', seq: 1, time: now - 3000, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: now - 2800, data: { turn: 1, step: 1, callId: 'm1', name: 'read', arguments: '{"file_path":"page.js"}' } },
]
// 只存在于日志里的老会话：活会话列表里没有它，只能走 inspect
const oldEvents = [
  { type: 'turn/start', seq: 1, time: now - 90000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: now - 89000, data: { role: 'user', content: '很久以前的一句话' } },
  { type: 'turn/end', seq: 3, time: now - 88000, data: { reason: { kind: 'error', error: { message: '模型超时' } } } },
]

const liveSession = (id, header, events) => ({
  id,
  header,
  seq: events.length ? events[events.length - 1].seq : 0,
  snapshotEvents: (from, to) => events.filter((e) => e.seq > from && e.seq <= to),
})
const leadHeader = { version: 1, id: lead.id, createdAt: now - 60000, cwd: 'C:\\work', isSeeded: false }
const mateHeader = { version: 1, id: mate.id, createdAt: now - 30000, cwd: 'C:\\work', isSeeded: false, origin: 'subagent', delegationDepth: 1 }
const leadLive = liveSession(lead.id, leadHeader, leadEvents)
const mateLive = liveSession(mate.id, mateHeader, mateEvents)

/* 假服务记下的调用：用来断言「手机发出去的东西」变成了什么 */
const prompts = []
const attachments = []
const inspections = []

const services = {
  webServer: web,
  agents: { list: () => [lead, mate], roots: () => [lead] },
  sessions: {
    list: () => [leadLive, mateLive],
  },
  agentTeams: {
    tryMembership: (agent) => (agent.id === lead.id ? { root: lead, id: 'team-1', role: 'lead', name: 'lead' } : null),
    listMembers: () => [
      { id: lead.id, name: 'lead', role: 'lead', status: 'running', description: '统筹全局' },
      { id: mate.id, name: 'worker-a', role: 'teammate', status: 'inactive', description: '写页面' },
    ],
    listTasks: () => [
      { id: 't1', revision: 3, subject: '写插件骨架', description: 'index.js + package.json', status: 'completed', blockedBy: [], writeScopes: [], ownerName: 'lead', ready: true, writeScopeWarnings: [] },
      { id: 't2', revision: 1, subject: '手机端页面', description: '自包含 HTML', status: 'in_progress', blockedBy: [], writeScopes: ['page.js'], ownerName: 'worker-a', ready: true, writeScopeWarnings: [] },
      { id: 't3', revision: 1, subject: '已删除的任务', description: '', status: 'deleted', blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] },
      { id: 't4', revision: 1, subject: '等待依赖', description: '', status: 'pending', blockedBy: ['t2'], writeScopes: [], ready: false, writeScopeWarnings: ['overlap'] },
    ],
  },
  jobs: {
    list: (caller) => {
      if (!caller) return [{ id: 'job-0', kind: 'bash', label: '无主作业', status: 'completed', startedAt: now - 90000, finishedAt: now - 80000 }]
      if (caller === lead.id) return [{ id: 'job-1', kind: 'bash', label: 'pnpm install', status: 'running', progress: '3/8 packages', startedAt: now - 12000, output: { total: 0, earliest: 0 } }]
      throw new Error('not your job')
    },
  },
  goals: {
    get: (agent) => {
      if (agent.id !== lead.id) throw new Error('GoalError: not registered')
      return { id: 'goal-1', revision: 2, objective: '写一个局域网手机看任务情况的插件', phase: 'active', maxGoalRounds: 12, roundsStarted: 3, createdAt: now - 100000, updatedAt: now - 5000, activation: 'armed' }
    },
  },
  // 权威会话状态：running 故意和日志推断相反（mate 日志里跑过，但 controller 说它空闲），
  // 这样才验证得出快照到底听了谁的。
  sessionController: {
    list: async () => ({
      items: [
        { agentAvailable: true, sessionId: lead.id, updatedAt: now - 1000, running: true, blank: false, cwd: 'C:\\work' },
        { agentAvailable: true, sessionId: mate.id, updatedAt: now - 2000, running: false, blank: false, parentSessionId: lead.id, origin: 'subagent' },
        // 只在日志里的老会话：手机上点进去会走 inspect 这条路
        { agentAvailable: false, sessionId: 'session-old-0003', updatedAt: now - 80000, running: false, blank: false },
      ],
    }),
    prompt: async (request) => {
      prompts.push(request)
      return { accepted: true }
    },
    attachment: async (request) => {
      attachments.push(request)
      if (request.attachmentId !== 'att-1') return null
      return {
        attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: IMG_BYTES.length, width: 2, height: 2, name: 'shot.png' },
        data: IMG_B64,
      }
    },
    inspect: async (id) => {
      inspections.push(id)
      return { meta: { version: 1, id, createdAt: now - 90000 }, inheritedEventCount: 0, events: oldEvents }
    },
  },
  sessionTitle: {
    get: (session) => ({ title: session.id === lead.id ? '局域网插件主线' : '手机页面子任务' }),
  },
}

const HAS_CONTROLLER = !process.env.SMOKE_NO_CONTROLLER
if (!HAS_CONTROLLER) delete services.sessionController
if (!HAS_WEB) delete services.webServer

/* ── 假 ctx ── */
const handlers = new Map()
const disposers = []
const ctx = {
  get: (name) => services[name],
  on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(fn)
    return () => {}
  },
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return () => {}
  },
}
const emit = (event, ...args) => {
  for (const fn of handlers.get(event) || []) fn(...args)
}

apply(ctx, { port: PORT, host: process.env.SMOKE_HOST || '127.0.0.1', history: 20, intervalMs: 800 })

/* 面板路由跑在 PORT+1 上；SMOKE_NO_WEB=1 时插件不注册任何路由，于是全是 404 */
const panelServer = await serveRoutes(web.routes, PANEL_PORT)

/* ── 喂几帧事件，让「最新动态」有东西 ── */
const leadSession = { id: lead.id }
const mateSession = { id: mate.id }
for (const event of leadEvents) emit('session/event', leadSession, event)
for (const event of mateEvents) emit('session/event', mateSession, event)
emit('agent/status', { agent: lead, status: 'running' })
emit('agent/status', { agent: mate, status: 'running' })

/* ── 等监听起来再发请求 ── */
await new Promise((r) => setTimeout(r, 700))

const base = `http://127.0.0.1:${PORT}`
const results = []
// 需要拿「HTTP 真发出去的那份字节」做离线解码验证时，用 SMOKE_DUMP_SERVED 指定落盘路径
const servedSamples = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

// 1. healthz
const health = await fetch(`${base}/healthz`).then((r) => r.json())
check('healthz 返回 ok', health.ok === true && health.listening === true, JSON.stringify({ port: health.port, urls: health.urls }))
check('healthz 标注发送开关', health.send === 'on', String(health.send))

// 2. 页面
const pageRes = await fetch(`${base}/`)
const pageHtml = await pageRes.text()
check('页面 200 + 自包含', pageRes.status === 200 && pageHtml.includes('DSH 任务看板') && !/https?:\/\/(?!127\.0\.0\.1)/.test(pageHtml), `len=${pageHtml.length}`)
check('页面无外部资源', !pageHtml.includes('cdn.') && !pageHtml.includes('unpkg') && !pageHtml.includes('googleapis'))

// 3. 快照
const snap = await fetch(`${base}/api/state`).then((r) => r.json())
check('快照 ok', snap.ok === true, `keys=${Object.keys(snap).join(',')}`)
check('agents 两条', snap.agents.length === 2, JSON.stringify(snap.agents.map((a) => [a.short, a.kind, a.running])))
const byId = Object.fromEntries(snap.agents.map((a) => [a.id, a]))
check(
  HAS_CONTROLLER ? '在跑状态以 sessionController 为准' : '无 controller 时回退到日志推断',
  HAS_CONTROLLER
    ? byId[lead.id].running === true && byId[mate.id].running === false && snap.stats.running === 1
    : byId[lead.id].running === true && byId[mate.id].running === true && snap.stats.running === 2,
  snap.agents.map((a) => `${a.id.split('-')[1]}:${a.running}`).join(' '),
)
check(
  'running 来源标注正确',
  snap.agents.every((a) => a.resolution === (HAS_CONTROLLER ? 'controller' : 'log')),
  snap.agents.map((a) => a.resolution).join(','),
)
check('会话标题来自 sessionTitle', byId[lead.id].title === '局域网插件主线' && byId[mate.id].title === '手机页面子任务', snap.agents.map((a) => a.title).join(' | '))
check(
  '回退时有提示 / 正常时无提示',
  HAS_CONTROLLER ? snap.notes.length === 0 : snap.notes.some((n) => n.includes('日志推断')),
  JSON.stringify(snap.notes),
)
check('stats 正确', snap.stats.agents === 2 && snap.stats.tasks === 3 && snap.stats.tasksActive === 1 && snap.stats.tasksDone === 1, JSON.stringify(snap.stats))
check('deleted 任务被过滤', !snap.tasks.some((t) => t.status === 'deleted'), `tasks=${snap.tasks.map((t) => t.id).join(',')}`)
check('任务排序 in_progress 优先', snap.tasks[0].status === 'in_progress', snap.tasks.map((t) => t.status).join('>'))
check('团队 2 人', snap.members.length === 2 && snap.members[0].role === 'lead', JSON.stringify(snap.members.map((m) => m.name)))
check('作业合并去重', snap.jobs.length === 2 && snap.stats.jobsRunning === 1, snap.jobs.map((j) => `${j.id}:${j.status}`).join(' '))
check('目标读到', !!snap.goal && snap.goal.phase === 'active' && snap.goal.roundsStarted === 3, snap.goal && snap.goal.objective)
check('动态有内容', snap.activity.length >= 5, `activity=${snap.activity.length}`)
check('动态最新在前', snap.activity[0].t >= snap.activity[snap.activity.length - 1].t)
check('元信息完整', snap.version === '1.3.0' && typeof snap.port === 'number' && Array.isArray(snap.addresses))

// 4. SSE
const sseText = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('SSE 超时')), 4000)
  fetch(`${base}/api/stream`).then(async (r) => {
    const reader = r.body.getReader()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      if (buf.includes('data: ') && buf.includes('"stats"')) {
        clearTimeout(timer)
        reader.cancel().catch(() => {})
        resolve(buf)
        return
      }
    }
  }).catch(reject)
})
check('SSE 推出快照', sseText.includes('data: ') && sseText.includes('"ok":true'), `chunk=${sseText.split('\n')[0].slice(0, 60)}`)

// 5. 鉴权 / 404 / 405
const notFound = await fetch(`${base}/nope`)
check('未知路径 404', notFound.status === 404, String(notFound.status))
const method = await fetch(`${base}/api/state`, { method: 'POST' })
check('非 GET 405', method.status === 405, String(method.status))
const icon = await fetch(`${base}/icon.svg`)
check('图标 200 svg', icon.status === 200 && (icon.headers.get('content-type') || '').includes('svg'))
const manifest = await fetch(`${base}/manifest.webmanifest`).then((r) => r.json())
check('manifest 可解析', manifest.display === 'standalone' && Array.isArray(manifest.icons))

// 6. 桌面面板：宿主 webServer 上的三条路由
const panelBase = `http://127.0.0.1:${PANEL_PORT}`
check(
  HAS_WEB ? '注册了三条面板路由' : '没有 webServer 时不注册任何路由',
  HAS_WEB
    ? web.routes.has('/lan-tasks/state') && web.routes.has('/lan-tasks/qr.svg') && web.routes.has('/lan-tasks/qr.txt')
    : web.routes.size === 0,
  [...web.routes.keys()].join(' '),
)

if (!HAS_WEB) {
  const miss = await fetch(`${panelBase}/lan-tasks/state`)
  check('无 webServer 时面板路由 404', miss.status === 404, String(miss.status))
} else {
  const panelRes = await fetch(`${panelBase}/lan-tasks/state`)
  const panel = await panelRes.json()
  check('面板状态 200 JSON', panelRes.status === 200 && panel.ok === true && panel.name === 'dsh-lan-tasks', `${panelRes.status}`)
  check(
    '面板版本/监听/端口',
    panel.version === '1.3.0' && panel.listening === true && panel.port === PORT,
    JSON.stringify({ version: panel.version, listening: panel.listening, port: panel.port }),
  )
  check('面板本机入口 + 无口令', panel.localUrl === `http://127.0.0.1:${PORT}/` && panel.token === 'off', panel.localUrl)
  const list = panel.addresses || []
  check(
    '面板地址字段完整',
    list.length >= 1 &&
      list.every(
        (a, i) => a.index === i && typeof a.address === 'string' && a.url === `http://${a.address}:${PORT}/` && a.qr === `/lan-tasks/qr.svg?i=${i}`,
      ),
    list.map((a) => `${a.index}:${a.address}`).join(' '),
  )
  check('面板统计与会话数', panel.stats.agents === 2 && panel.sessions === 2, JSON.stringify({ stats: panel.stats, sessions: panel.sessions }))

  const svgRes = await fetch(`${panelBase}/lan-tasks/qr.svg`)
  const svg = await svgRes.text()
  if (list.length) {
    check('二维码 200 + 类型正确', svgRes.status === 200 && (svgRes.headers.get('content-type') || '').includes('image/svg+xml'), svgRes.headers.get('content-type') || '')
    check('二维码与编码器逐字节一致', svg === qrSvg(list[0].url), `len=${svg.length}`)
    // 只允许 w3 的 xmlns 这一个外部字符串：二维码内容本身不落进 SVG 文本
    check(
      '二维码自包含（无脚本/无外链）',
      svg.includes('<svg') &&
        !svg.includes('<script') &&
        svg.includes('xmlns="http://www.w3.org/2000/svg"') &&
        (svg.match(/https?:\/\//g) || []).length === 1,
    )
    const matrix = qrMatrix(list[0].url)
    const box = matrix.size + 8
    check(
      '二维码版本与画布一致',
      svg.includes(`viewBox="0 0 ${box} ${box}"`) && svg.includes(`width="${box * 8}" height="${box * 8}"`),
      `version=${matrix.version} size=${matrix.size} mask=${matrix.mask}`,
    )
    check('索引越界退回第一个地址', (await fetch(`${panelBase}/lan-tasks/qr.svg?i=99`).then((r) => r.text())) === svg)
    check('索引非数字退回第一个地址', (await fetch(`${panelBase}/lan-tasks/qr.svg?i=abc`).then((r) => r.text())) === svg)
    const txtRes = await fetch(`${panelBase}/lan-tasks/qr.txt`)
    const txt = await txtRes.text()
    check('字符画 200 text/plain', txtRes.status === 200 && (txtRes.headers.get('content-type') || '').includes('text/plain'))
    check('字符画第一行是 URL', txt.split('\n')[0] === list[0].url, txt.split('\n')[0])
    check('字符画是半块字符', txt.includes('▀'))
    servedSamples.push({ url: list[0].url, svg, ascii: txt })
  } else {
    check('无局域网地址时二维码 404', svgRes.status === 404 && svg.includes('no lan address'), String(svgRes.status))
  }
}

// 7. 带访问口令的实例：面板路由不该被手机端口令挡住
const web2 = makeWebServer()
const ctx2 = {
  get: (name) => (name === 'webServer' ? web2 : services[name]),
  on: () => () => {},
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return () => {}
  },
}
apply(ctx2, { port: TOKEN_PORT, host: '127.0.0.1', token: TOKEN, history: 5, intervalMs: 800 })
const panel2Server = await serveRoutes(web2.routes, TOKEN_PANEL_PORT)
const tokenBase = `http://127.0.0.1:${TOKEN_PORT}`
check('有口令时手机端 401', (await fetch(`${tokenBase}/api/state`)).status === 401)
check('?k= 口令放行', (await fetch(`${tokenBase}/api/state?k=${encodeURIComponent(TOKEN)}`)).status === 200)
check('x-dsh-token 头放行', (await fetch(`${tokenBase}/api/state`, { headers: { 'x-dsh-token': TOKEN } })).status === 200)
check(
  '带口令时发消息也要口令',
  (await fetch(`${tokenBase}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401,
)
const panel2 = await fetch(`http://127.0.0.1:${TOKEN_PANEL_PORT}/lan-tasks/state`).then((r) => r.json())
const list2 = panel2.addresses || []
check('面板不受口令影响 + URL 带 k', panel2.token === 'required' && list2.length >= 1 && list2[0].url.endsWith(`/?k=${TOKEN}`), list2[0] && list2[0].url)
if (list2.length) {
  const svg2 = await fetch(`http://127.0.0.1:${TOKEN_PANEL_PORT}/lan-tasks/qr.svg`).then((r) => r.text())
  check('带口令的长 URL 二维码一致', svg2 === qrSvg(list2[0].url), `len=${svg2.length}`)
  const txt2 = await fetch(`http://127.0.0.1:${TOKEN_PANEL_PORT}/lan-tasks/qr.txt`).then((r) => r.text())
  check('带口令字符画第一行是 URL', txt2.split('\n')[0] === list2[0].url)
  servedSamples.push({ url: list2[0].url, svg: svg2, ascii: txt2 })
}

// 8. 会话详情：手机上点进会话看的那份时间线
const detailUrl = (id, extra = '') => `${base}/api/session?id=${encodeURIComponent(id)}${extra}`
check('详情缺 id → 400', (await fetch(`${base}/api/session`)).status === 400)
check('详情未知会话 → 404', (await fetch(detailUrl('session-nope'))).status === 404)

const detailRes = await fetch(detailUrl(lead.id))
const detail = await detailRes.json()
check('详情 200 + 读活会话日志', detailRes.status === 200 && detail.ok === true && detail.source === 'live', `${detailRes.status} source=${detail.source}`)
check(
  '详情头部字段',
  detail.title === '局域网插件主线' && detail.running === true && detail.short === 'lead-0' && typeof detail.cwd === 'string' && detail.cwd.length > 2,
  JSON.stringify({ title: detail.title, running: detail.running, short: detail.short }),
)
const kinds = (detail.records || []).map((r) => r.kind)
check('时间线按类型投影', kinds.join(',') === 'sys,user,tool,assistant,user,tool,err', kinds.join(','))
check(
  '工具行带参数摘要',
  (detail.records || []).some((r) => r.kind === 'tool' && r.brief === 'pnpm install'),
  JSON.stringify((detail.records || []).filter((r) => r.kind === 'tool').map((r) => r.brief)),
)
const imgRec = (detail.records || []).find((r) => (r.images || []).length)
check(
  '历史图片变成可取的路由',
  !!imgRec && imgRec.images[0].url === `/api/image?id=${encodeURIComponent(lead.id)}&a=att-1` && imgRec.images[0].mediaType === 'image/png',
  imgRec && imgRec.images[0].url,
)
check('工具出错显示成 err 行', (detail.records.find((r) => r.kind === 'err') || {}).text === '命令失败')
check('正常工具结果不占行', (detail.records || []).length === 7, `records=${(detail.records || []).length}`)
check(
  '发送能力字段',
  detail.allowSend === true && detail.canSend === HAS_CONTROLLER && detail.maxImages === 4 && detail.maxImageBytes === 6 * 1024 * 1024,
  JSON.stringify({ allowSend: detail.allowSend, canSend: detail.canSend }),
)
check('短会话 hasMore=false + 默认 limit', detail.hasMore === false && detail.limit === 80, JSON.stringify({ hasMore: detail.hasMore, limit: detail.limit }))

const small = await fetch(detailUrl(lead.id, '&limit=3')).then((r) => r.json())
check('limit 生效 + hasMore=true', small.limit === 3 && small.count === 3 && small.hasMore === true, JSON.stringify({ limit: small.limit, count: small.count, hasMore: small.hasMore }))
check('非法 limit 回默认 80', (await fetch(detailUrl(lead.id, '&limit=abc')).then((r) => r.json())).limit === 80)

if (HAS_CONTROLLER) {
  const oldRes = await fetch(detailUrl('session-old-0003'))
  const old = await oldRes.json()
  check('不在内存里的会话走 inspect', oldRes.status === 200 && old.source === 'inspect' && inspections.includes('session-old-0003'), `${oldRes.status} ${old.source}`)
  check(
    'turn/end 出错显示成 err',
    (old.records || []).some((r) => r.kind === 'err' && String(r.text).includes('本轮出错')),
    JSON.stringify((old.records || []).map((r) => `${r.kind}:${r.text}`)),
  )
} else {
  check('没有会话服务时老会话 404', (await fetch(detailUrl('session-old-0003'))).status === 404)
}

// 9. 历史图片：代理成 <img> 能直接用的字节
check('图片缺参数 → 400', (await fetch(`${base}/api/image?id=${encodeURIComponent(lead.id)}`)).status === 400)
const imgRes = await fetch(`${base}/api/image?id=${encodeURIComponent(lead.id)}&a=att-1`)
if (HAS_CONTROLLER) {
  const imgBuf = Buffer.from(await imgRes.arrayBuffer())
  check(
    '图片按原字节返回',
    imgRes.status === 200 && imgBuf.equals(IMG_BYTES) && (imgRes.headers.get('content-type') || '') === 'image/png',
    `${imgRes.status} ${imgBuf.length}B`,
  )
  check('未知附件 → 502', (await fetch(`${base}/api/image?id=${encodeURIComponent(lead.id)}&a=nope`)).status === 502)
} else {
  check('没有会话服务时图片 503', imgRes.status === 503, String(imgRes.status))
}

// 10. 发消息 / 发图片：唯一写入口
const send = (payload, headers = { 'content-type': 'application/json' }) =>
  fetch(`${base}/api/send`, { method: 'POST', headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) })

check('GET /api/send → 405', (await fetch(`${base}/api/send`)).status === 405)
check('发送必须是 JSON（顺手挡 CSRF）', (await send({ sessionId: lead.id, text: 'hi' }, { 'content-type': 'application/x-www-form-urlencoded' })).status === 415)

if (HAS_CONTROLLER) {
  check('发送缺 sessionId → 400', (await send({ text: 'hi' })).status === 400)
  check('发送未知会话 → 404', (await send({ sessionId: 'session-nope', text: 'hi' })).status === 404)

  const before = prompts.length
  check('空消息 → 400', (await send({ sessionId: lead.id })).status === 400)
  check('图片类型不支持 → 400', (await send({ sessionId: lead.id, images: [{ mediaType: 'image/bmp', data: IMG_B64 }] })).status === 400)
  check('图片不是 base64 → 400', (await send({ sessionId: lead.id, images: [{ mediaType: 'image/png', data: 'not*base64!' }] })).status === 400)
  check(
    '图片太多 → 400',
    (await send({ sessionId: lead.id, images: Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: IMG_B64 })) })).status === 400,
  )
  check('被拒的请求没有真的发给会话', prompts.length === before, `prompts=${prompts.length}`)

  const textRes = await send({ sessionId: lead.id, text: '手机发的话', mode: 'queue', tz: 'Asia/Shanghai' })
  const textBody = await textRes.json()
  check(
    '发文字 200 + 回执',
    textRes.status === 200 && textBody.ok === true && textBody.accepted === true && textBody.mode === 'queue' && textBody.parts === 1,
    JSON.stringify(textBody),
  )
  const sent = prompts[prompts.length - 1]
  check(
    'prompt 收到正确的请求',
    sent.sessionId === lead.id && sent.mode === 'queue' && sent.clientTimeZone === 'Asia/Shanghai' &&
      Array.isArray(sent.content) && sent.content.length === 1 && sent.content[0].type === 'text' && sent.content[0].text === '手机发的话',
    JSON.stringify(sent.content),
  )
  check('requestId 带前缀', String(sent.requestId).startsWith('lan-tasks-'), sent.requestId)

  const steer = await send({ sessionId: lead.id, text: '插一句', mode: 'steer' }).then((r) => r.json())
  check('steer 模式透传', steer.mode === 'steer' && prompts[prompts.length - 1].mode === 'steer', JSON.stringify(steer))

  const imgSend = await send({
    sessionId: lead.id,
    text: '看这张',
    images: [{ mediaType: 'image/png', data: `data:image/png;base64,${IMG_B64}`, name: 'a.png' }],
  }).then((r) => r.json())
  const imgSent = prompts[prompts.length - 1]
  check('发图片 200 + 计入回执', imgSend.ok === true && imgSend.images === 1 && imgSend.parts === 2, JSON.stringify(imgSend))
  check(
    '图片去掉 data: 前缀后进 prompt',
    imgSent.content[1].type === 'image' && imgSent.content[1].mediaType === 'image/png' && imgSent.content[1].data === IMG_B64 && imgSent.content[1].name === 'a.png',
    JSON.stringify(imgSent.content[1]),
  )

  const snap2 = await fetch(`${base}/api/state`).then((r) => r.json())
  const leadAgent = snap2.agents.find((a) => a.id === lead.id)
  check(
    '发完立刻反映到看板',
    snap2.activity.some((e) => e.who === '你（手机）' && e.text === '看这张') && leadAgent.last === '看这张',
    `last=${leadAgent.last}`,
  )
} else {
  check('没有会话服务时发送 503', (await send({ sessionId: lead.id, text: 'hi' })).status === 503)
}

// 11. allowSend: false 的实例：退回只读看板
const NO_SEND_PORT = PORT + 4
const ctx3 = {
  get: (name) => (name === 'webServer' ? makeWebServer() : services[name]),
  on: () => () => {},
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return () => {}
  },
}
apply(ctx3, { port: NO_SEND_PORT, host: '127.0.0.1', allowSend: false, history: 5, intervalMs: 800 })
const offBase = `http://127.0.0.1:${NO_SEND_PORT}`
const offRes = await fetch(`${offBase}/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: lead.id, text: 'hi' }),
})
check('allowSend=false → 403', offRes.status === 403, String(offRes.status))
check('healthz 报 send=off', (await fetch(`${offBase}/healthz`).then((r) => r.json())).send === 'off')
const offDetail = await fetch(`${offBase}/api/session?id=${encodeURIComponent(lead.id)}`).then((r) => r.json())
check('关掉发送后详情里也不能发', offDetail.allowSend === false && offDetail.canSend === false, JSON.stringify({ allowSend: offDetail.allowSend, canSend: offDetail.canSend }))

if (process.env.SMOKE_DUMP_SERVED) {
  writeFileSync(process.env.SMOKE_DUMP_SERVED, JSON.stringify(servedSamples, null, 2))
  console.log(`\n（已把 ${servedSamples.length} 份 HTTP 实际响应的二维码写到 ${process.env.SMOKE_DUMP_SERVED}）`)
}

console.log('\n' + results.filter((r) => !r.ok).length + ' 项失败 / 共 ' + results.length + ' 项')
for (const d of disposers) { try { d() } catch {} }
panelServer.close()
panel2Server.close()
process.exit(results.some((r) => !r.ok) ? 1 : 0)
