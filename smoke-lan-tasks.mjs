/**
 * 离线冒烟测试：不开 DSH，直接用假的 ctx 把插件跑起来，
 * 验证 HTTP 层、快照组装、SSE、鉴权、404 这些不依赖宿主的部分。
 *
 * 用法： node smoke-lan-tasks.mjs [port]
 */
import { apply } from './index.js'

const PORT = Number(process.argv[2] || 8799)

/* ── 假数据：尽量贴近真实契约 ── */
const lead = { id: 'session-lead-0001' }
const mate = { id: 'session-mate-0002' }
const now = Date.now()

const services = {
  agents: { list: () => [lead, mate], roots: () => [lead] },
  sessions: {
    list: () => [
      { id: lead.id, header: { version: 1, id: lead.id, createdAt: now - 60000, cwd: 'C:\\work', isSeeded: false } },
      { id: mate.id, header: { version: 1, id: mate.id, createdAt: now - 30000, isSeeded: false, origin: 'subagent', delegationDepth: 1 } },
    ],
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
      ],
    }),
  },
  sessionTitle: {
    get: (session) => ({ title: session.id === lead.id ? '局域网插件主线' : '手机页面子任务' }),
  },
}

const HAS_CONTROLLER = !process.env.SMOKE_NO_CONTROLLER
if (!HAS_CONTROLLER) delete services.sessionController

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

/* ── 喂几帧事件，让「最新动态」有东西 ── */
const leadSession = { id: lead.id }
emit('session/event', leadSession, { type: 'turn/start', seq: 1, time: now, data: { turn: 1 } })
emit('session/event', leadSession, { type: 'user/message', seq: 2, time: now, data: { role: 'user', content: '帮我看下任务情况' } })
emit('session/event', leadSession, {
  type: 'tool/call', seq: 3, time: now,
  data: { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{"command":"pnpm install","description":"装依赖"}' },
})
emit('session/event', leadSession, {
  type: 'tool/result', seq: 4, time: now,
  data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'done in 3.2s' }] } },
})
emit('session/event', mateSession(mate), { type: 'turn/start', seq: 5, time: now, data: { turn: 1 } })
emit('session/event', mateSession(mate), { type: 'tool/call', seq: 6, time: now, data: { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"file_path":"page.js"}' } })
emit('agent/status', { agent: lead, status: 'running' })
emit('agent/status', { agent: mate, status: 'running' })
function mateSession(a) { return { id: a.id } }

/* ── 等监听起来再发请求 ── */
await new Promise((r) => setTimeout(r, 700))

const base = `http://127.0.0.1:${PORT}`
const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

// 1. healthz
const health = await fetch(`${base}/healthz`).then((r) => r.json())
check('healthz 返回 ok', health.ok === true && health.listening === true, JSON.stringify({ port: health.port, urls: health.urls }))

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
check('元信息完整', snap.version === '1.1.0' && typeof snap.port === 'number' && Array.isArray(snap.addresses))

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

console.log('\n' + results.filter((r) => !r.ok).length + ' 项失败 / 共 ' + results.length + ' 项')
for (const d of disposers) { try { d() } catch {} }
process.exit(results.some((r) => !r.ok) ? 1 : 0)
