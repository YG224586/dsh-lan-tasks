/**
 * dsh-lan-tasks · Host 半边
 *
 * 只做一件事：把「现在的任务情况」变成一个手机浏览器能打开的局域网网页。
 *
 *   GET  /                     手机端页面（自包含 HTML）
 *   GET  /api/state            整份状态快照 JSON
 *   GET  /api/stream           SSE，状态有变化就推一次
 *   GET  /api/session?id=…     某个会话的时间线（点进会话看详情用）
 *   GET  /api/image?id=…&a=…   转发会话日志里的图片（手机端直接 <img> 引用）
 *   POST /api/send             从手机发消息 / 发图片进会话（allowSend 控制）
 *   GET  /manifest.webmanifest 加到主屏幕用
 *   GET  /icon.svg             图标
 *   GET  /healthz              自检：监听地址、可达 URL、版本
 *
 * 另外把桌面 GUI 面板要用的三个路由挂到宿主的 webServer 上（和 GUI 同源，不用跨域）：
 *
 *   GET /lan-tasks/state      面板数据：版本、监听状态、局域网地址 + 二维码、统计
 *   GET /lan-tasks/qr.svg?i=N 第 N 个局域网地址的二维码（SVG）
 *   GET /lan-tasks/qr.txt?i=N 同一张二维码的终端字符画
 *
 * 看板数据全部是只读投影：agents / sessions / agentTeams / jobs / goals，
 * 外加一份自己维护的「最近动态」环形缓冲。任何一步读不到都只让对应段落消失，
 * 绝不抛到 DSH 主流程里 —— 看板挂掉不能把宿主带崩。
 *
 * 唯一的写入口是 POST /api/send：它调用 sessionController.prompt()，等价于在桌面
 * 输入框里敲了一句话。开了它等于把 agent 的遥控器交到同网段手里，所以有 config.allowSend
 * 开关（默认开），并且在没设 token 时启动横幅会明确警告。读接口（/api/session、/api/image）
 * 在任何情况下都只是回显会话日志。
 *
 * 手机页面必须自己监听 0.0.0.0（宿主 webServer 只监听 127.0.0.1，手机过不来）；
 * 桌面面板反过来必须走宿主 webServer，否则 GUI 里 fetch 会跨域。
 */
import http from 'node:http'
import os from 'node:os'
import { ICON_SVG, renderPage } from './page.js'
import { qrAscii, qrSvg } from './qrcode.js'

export const inject = ['webServer']

const NAME = 'dsh-lan-tasks'
const VERSION = '1.3.0'

const DEFAULTS = {
  /** 监听端口。和 DSH 的 19387 错开，避免抢端口。 */
  port: 8791,
  /** 必须绑 0.0.0.0，否则手机连不上。 */
  host: '0.0.0.0',
  /** 留空 = 不校验；填了就要求 ?k=<token> 或 x-dsh-token 头。 */
  token: '',
  /** 「最新动态」保留条数。 */
  history: 60,
  /** SSE 推送间隔（毫秒）。 */
  intervalMs: 2000,
  /**
   * 允许手机端发消息 / 发图片进会话。
   *
   * 这等于把 agent 的遥控器交出去：同网段任何人都能让它执行工具。家里/办公室
   * 自用网络默认开着方便，公用网络请配 token 或改成 false。
   */
  allowSend: true,
  /** 单张图片上限（字节）。 */
  maxImageBytes: 6 * 1024 * 1024,
  /** 一条消息最多带几张图。 */
  maxImages: 4,
}

/* ────────────────────────── 小工具 ────────────────────────── */

function msg(err) {
  return String((err && err.message) || err || 'unknown error')
}

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 和 clip 一样截断，但保留换行 —— 手机上看消息正文要靠它。 */
function trimText(value, max) {
  const s = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function shortId(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 6)
}

/** 从任意 message 形状里抠出纯文本，抠不到就返回空串。 */
function textOf(message) {
  if (!message || typeof message !== 'object') return ''
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim()
}

/** 工具入参是个 JSON 字符串，优先挑出人看得懂的那一两个字段。 */
function briefArgs(raw) {
  if (raw == null) return ''
  const s = typeof raw === 'string' ? raw : (() => {
    try {
      return JSON.stringify(raw)
    } catch {
      return ''
    }
  })()
  if (!s) return ''
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'prompt', 'description', 'url', 'objective']) {
        if (typeof parsed[key] === 'string' && parsed[key]) return clip(parsed[key], 140)
      }
    }
  } catch {
    /* 不是完整 JSON（流式截断），退回原文 */
  }
  return clip(s, 140)
}

/** 本机所有非回环 IPv4 —— 手机要用的就是这些。 */
function lanAddresses() {
  const out = []
  let ifaces
  try {
    ifaces = os.networkInterfaces() || {}
  } catch {
    return out
  }
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (!info) continue
      const family = typeof info.family === 'string' ? info.family : String(info.family)
      if (family !== 'IPv4' || info.internal) continue
      out.push({ name, address: info.address })
    }
  }
  // 家用/办公网段排前面，VPN 虚拟网卡排后面
  out.sort((a, b) => rank(a.address) - rank(b.address))
  return out
}

function rank(address) {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2
  return 3
}

/* ────────────────────────── 插件本体 ────────────────────────── */

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const port = Number.isInteger(cfg.port) && cfg.port >= 0 && cfg.port <= 65535 ? cfg.port : DEFAULTS.port
  const host = typeof cfg.host === 'string' && cfg.host.trim() ? cfg.host.trim() : DEFAULTS.host
  const token = typeof cfg.token === 'string' ? cfg.token.trim() : ''
  const historyLimit = Number.isInteger(cfg.history) && cfg.history > 0 ? cfg.history : DEFAULTS.history
  const intervalMs = Number.isInteger(cfg.intervalMs) && cfg.intervalMs >= 500 ? cfg.intervalMs : DEFAULTS.intervalMs
  const allowSend = cfg.allowSend !== false
  const maxImageBytes =
    Number.isInteger(cfg.maxImageBytes) && cfg.maxImageBytes > 0 ? cfg.maxImageBytes : DEFAULTS.maxImageBytes
  const maxImages = Number.isInteger(cfg.maxImages) && cfg.maxImages > 0 ? cfg.maxImages : DEFAULTS.maxImages
  /** 请求体上限：base64 比原图大 1/3，再留一点余量给文本字段。 */
  const maxBodyBytes = Math.ceil(maxImageBytes * maxImages * 1.4) + 256 * 1024

  /** 可选服务：拿不到就返回 undefined，调用方各自兜底。 */
  const svc = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  /** 每个会话的实时画像，key 是 session id。 */
  const tracks = new Map()
  /** 「最新动态」环形缓冲，新的在前。 */
  const activity = []
  /** toolCallId -> 工具名，用来给 tool/result 补上是谁的结果。 */
  const pendingCalls = new Map()

  function track(id) {
    const key = String(id || '')
    let record = tracks.get(key)
    if (!record) {
      record = {
        id: key,
        running: false,
        since: 0,
        title: '',
        last: '',
        lastKind: '',
        action: null,
        turns: 0,
        tokens: 0,
        errors: 0,
        updatedAt: 0,
      }
      tracks.set(key, record)
    }
    return record
  }

  function feed(sessionId, kind, text, who) {
    if (!text) return
    activity.unshift({
      t: Date.now(),
      sid: shortId(sessionId),
      kind,
      who: who || label(sessionId),
      text: clip(text, 160),
    })
    if (activity.length > historyLimit) activity.length = historyLimit
  }

  /** 动态行里的人名：优先会话标题，其次短 id。 */
  function label(sessionId) {
    const record = tracks.get(String(sessionId || ''))
    return (record && record.title) || shortId(sessionId)
  }

  /**
   * 冷启动补种。
   *
   * 插件是在 DSH 跑了一阵之后才装上的，所以「当前是否在跑」这类状态事件早就发过了，
   * 只订阅事件的话所有会话看起来都是空闲的。这里直接回读每个会话日志的尾巴，
   * 用最后一个 turn/start 还是 turn/end 判断它此刻在不在干活。
   */
  function seedSession(session) {
    const id = String((session && session.id) || '')
    if (!id) return
    const record = track(id)
    record.seeded = true
    record.updatedAt = record.updatedAt || Date.now()

    let seq = 0
    try {
      seq = Number(session.seq) || 0
    } catch {
      seq = 0
    }
    if (seq <= 0) return

    let events = []
    try {
      events = session.snapshotEvents(Math.max(0, seq - 60), seq) || []
    } catch {
      return
    }
    if (!events.length) return

    // 1. 在不在跑：从尾巴往前找第一个 turn 边界
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event) continue
      if (event.type === 'turn/end') {
        record.running = false
        break
      }
      if (event.type === 'turn/start') {
        record.running = true
        record.since = Number(event.time) || Date.now()
        break
      }
    }

    // 2. 最近说了什么、正在调什么工具
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event) continue
      const data = event.data || {}
      if (!record.last && event.type === 'assistant/message') {
        const text = textOf(data.message)
        if (text) {
          record.last = clip(text, 220)
          record.lastKind = 'assistant'
        }
      }
      if (!record.last && event.type === 'user/message') {
        const text = textOf(data)
        if (text) {
          record.last = clip(text, 220)
          record.lastKind = 'user'
          if (!record.title) record.title = clip(text, 60)
        }
      }
      if (!record.action && event.type === 'tool/call') {
        record.action = { name: String(data.name || '工具'), brief: briefArgs(data.arguments), at: Number(event.time) || Date.now() }
      }
      if (record.last && record.action) break
    }

    // 3. 轮次
    for (const event of events) {
      if (event && event.type === 'turn/start') {
        const turn = Number(event.data && event.data.turn) || 0
        if (turn > record.turns) record.turns = turn
      }
    }

    const tail = events[events.length - 1]
    if (tail && Number(tail.time)) record.updatedAt = Math.max(record.updatedAt, Number(tail.time))
  }

  /** 标题：优先取标题服务（用户改过名也能跟上），退回日志里抓的第一句用户话。 */
  function titleOf(session, record) {
    try {
      const snapshot = svc('sessionTitle')?.get?.(session)
      const title = snapshot && (snapshot.title || snapshot.text || snapshot.value)
      if (typeof title === 'string' && title.trim()) return clip(title, 60)
    } catch {
      /* 标题服务不在或这个会话没有标题 */
    }
    return (record && record.title) || ''
  }

  /* ── 事件订阅：把实时状态攒起来 ── */

  function onSessionEvent(session, event) {
    try {
      const id = String((session && session.id) || '')
      const type = event && event.type
      const data = (event && event.data) || {}
      const record = track(id)
      record.updatedAt = Date.now()

      switch (type) {
        case 'turn/start':
          record.turns = Math.max(record.turns, Number(data.turn) || 0)
          record.running = true
          record.since = record.since || Date.now()
          feed(id, 'sys', `第 ${data.turn ?? '?'} 轮开始`)
          break

        case 'turn/end': {
          const kind = (data.reason && data.reason.kind) || 'end'
          record.running = false
          record.since = 0
          if (kind === 'error') {
            record.errors += 1
            feed(id, 'err', `本轮出错：${clip((data.reason.error && data.reason.error.message) || '', 100)}`)
          } else {
            feed(id, 'sys', `本轮结束（${kind}）`)
          }
          break
        }

        case 'tool/call': {
          const name = String(data.name || '工具')
          record.action = { name, brief: briefArgs(data.arguments), at: Date.now() }
          if (data.callId) pendingCalls.set(String(data.callId), name)
          feed(id, 'tool', `${name} ${briefArgs(data.arguments)}`)
          break
        }

        case 'tool/result': {
          const callId = String(
            (data.message && data.message.toolCallId) || data.callId || '',
          )
          const name = pendingCalls.get(callId) || '工具'
          pendingCalls.delete(callId)
          record.action = null
          if (data.error) {
            record.errors += 1
            feed(id, 'err', `${name} 失败：${clip(data.error.reason || data.error.name || data.error.code, 100)}`)
          } else {
            const preview = textOf(data.message)
            feed(id, 'tool', preview ? `${name} → ${preview}` : `${name} 完成`)
          }
          break
        }

        case 'assistant/message': {
          const text = textOf(data.message)
          if (text) {
            record.last = clip(text, 220)
            record.lastKind = 'assistant'
          }
          const usage = data.usage
          if (usage) {
            const total = typeof usage.totalTokens === 'number'
              ? usage.totalTokens
              : (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
            if (total > 0) record.tokens += total
          }
          if (text) feed(id, 'assistant', text)
          break
        }

        case 'user/message': {
          const text = textOf(data)
          if (text) {
            if (!record.title) record.title = clip(text, 60)
            record.last = clip(text, 220)
            record.lastKind = 'user'
            record.since = record.since || Date.now()
            feed(id, 'user', text, '你')
          }
          break
        }

        default:
          break
      }
    } catch {
      /* 观察者绝不能把提交路径带崩 */
    }
  }

  function onAgentStatus(payload) {
    try {
      const agent = payload && payload.agent
      const status = payload && payload.status
      if (!agent || !agent.id) return
      const record = track(agent.id)
      const running = status === 'running'
      if (record.running !== running) {
        record.running = running
        record.since = running ? Date.now() : 0
        record.updatedAt = Date.now()
        feed(agent.id, running ? 'sys' : 'sys', running ? '开始工作' : '转入空闲')
      }
    } catch {
      /* 同上 */
    }
  }

  function onSubagent(info, phase) {
    try {
      const name = (info && (info.description || info.name || info.label)) || '子代理'
      feed((info && info.sessionId) || '', 'sys', `${phase}：${clip(name, 80)}`, '子代理')
    } catch {
      /* 同上 */
    }
  }

  function subscribe() {
    const disposers = []
    const on = (event, listener) => {
      try {
        const dispose = ctx.on(event, listener)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch {
        /* 这个事件在当前组合里不存在，跳过即可 */
      }
    }
    on('session/event', onSessionEvent)
    on('agent/status', onAgentStatus)
    on('subagent/start', (info) => onSubagent(info, '子代理启动'))
    on('subagent/end', (info) => onSubagent(info, '子代理结束'))
    on('turn/end', () => {}) // 占位：某些组合会把 turn/end 单独发出来
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 清理失败无所谓 */
        }
      }
    }
  }

  /* ── 快照：一次请求的全部数据 ── */

  function listAgents() {
    const service = svc('agents')
    if (!service || typeof service.list !== 'function') return null
    try {
      return service.list() || []
    } catch {
      return []
    }
  }

  function sessionIndex() {
    const headers = new Map()
    const live = new Map()
    const service = svc('sessions')
    if (!service || typeof service.list !== 'function') return { headers, live }
    let list = []
    try {
      list = service.list() || []
    } catch {
      list = []
    }
    for (const session of list) {
      try {
        const id = String(session.id)
        live.set(id, session)
        if (session.header) headers.set(id, session.header)
      } catch {
        /* 忽略单个坏会话 */
      }
    }
    return { headers, live }
  }

  function collectTeam(agents) {
    const result = { members: [], tasks: [], error: null }
    const service = svc('agentTeams')
    if (!service || !agents.length) return result
    for (const agent of agents) {
      let membership = null
      try {
        membership = typeof service.tryMembership === 'function' ? service.tryMembership(agent) : null
      } catch {
        membership = null
      }
      if (!membership) continue
      try {
        const members = typeof service.listMembers === 'function' ? service.listMembers(agent) : []
        result.members = (members || []).map((m) => ({
          id: String(m.id || ''),
          name: String(m.name || ''),
          role: String(m.role || ''),
          status: String(m.status || ''),
          description: m.description ? clip(m.description, 90) : '',
          model: m.model || '',
        }))
      } catch (err) {
        result.error = msg(err)
      }
      try {
        const tasks = typeof service.listTasks === 'function' ? service.listTasks(agent) : []
        const order = { in_progress: 0, pending: 1, completed: 2 }
        result.tasks = (tasks || [])
          .filter((t) => t && t.status !== 'deleted')
          .map((t) => ({
            id: String(t.id || ''),
            revision: Number(t.revision) || 0,
            subject: String(t.subject || ''),
            description: t.description ? clip(t.description, 160) : '',
            status: String(t.status || ''),
            blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
            owner: t.ownerName ? String(t.ownerName) : '',
            ready: !!t.ready,
            warnings: Array.isArray(t.writeScopeWarnings) ? t.writeScopeWarnings.length : 0,
          }))
          .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
      } catch (err) {
        result.error = msg(err)
      }
      break
    }
    return result
  }

  function collectJobs(agents) {
    const service = svc('jobs')
    if (!service || typeof service.list !== 'function') return []
    const map = new Map()
    const absorb = (list) => {
      for (const job of list || []) {
        if (job && job.id) map.set(String(job.id), job)
      }
    }
    try {
      absorb(service.list())
    } catch {
      /* 无主作业读不到就算了 */
    }
    for (const agent of agents) {
      try {
        absorb(service.list(agent.id))
      } catch {
        /* 别人的作业会拒绝，正常 */
      }
    }
    // 正在跑的永远排最前，其次失败，最后是跑完的旧作业按时间倒序
    const rank = (job) =>
      job.status === 'running' || job.status === 'stopping' ? 0 : job.status === 'failed' ? 1 : 2
    return [...map.values()]
      .sort((a, b) => rank(a) - rank(b) || (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0))
      .slice(0, 20)
      .map((job) => ({
        id: String(job.id),
        kind: String(job.kind || ''),
        label: clip(job.label || job.id, 90),
        status: String(job.status || ''),
        progress: job.progress ? clip(job.progress, 140) : '',
        detail: job.detail ? clip(job.detail, 140) : '',
        startedAt: Number(job.startedAt) || 0,
        finishedAt: Number(job.finishedAt) || 0,
      }))
  }

  function collectGoal(agents) {
    const service = svc('goals')
    if (!service || typeof service.get !== 'function' || !agents.length) return null
    const agentsService = svc('agents')
    let roots = []
    try {
      roots = typeof agentsService?.roots === 'function' ? agentsService.roots() || [] : []
    } catch {
      roots = []
    }
    const target = roots[0] || agents[0]
    try {
      const goal = service.get(target)
      if (!goal || typeof goal !== 'object') return null
      return {
        id: String(goal.id || ''),
        objective: clip(goal.objective || '', 240),
        phase: String(goal.phase || ''),
        activation: String(goal.activation || ''),
        roundsStarted: Number(goal.roundsStarted) || 0,
        maxGoalRounds: Number(goal.maxGoalRounds) || 0,
        updatedAt: Number(goal.updatedAt) || 0,
        blockedReason: goal.blockedReason
          ? { code: String(goal.blockedReason.code || ''), message: clip(goal.blockedReason.message || '', 160) }
          : null,
      }
    } catch {
      return null
    }
  }

  /**
   * 权威的在跑状态。
   *
   * `sessionController.list()` 直接给出每个会话的 `running` / `updatedAt` /
   * `parentSessionId` / `origin`（SessionSummary），比从日志尾巴猜可靠得多 ——
   * 一轮跑很久时，最近 60 条事件里可能根本没有 turn/start 边界。
   * 它是异步且走持久化读取的，所以放后台定时刷新，快照只读缓存。
   */
  const summaries = { at: 0, byId: new Map(), ok: false }
  let summaryInflight = null

  function refreshSummaries() {
    if (summaryInflight) return summaryInflight
    const service = svc('sessionController')
    if (!service || typeof service.list !== 'function') return Promise.resolve(false)

    const controller = new AbortController()
    const call = Promise.resolve()
      .then(() => service.list({}, controller.signal))
      .then((value) => {
        const items = (value && value.items) || []
        const byId = new Map()
        for (const item of items) {
          if (item && item.sessionId) byId.set(String(item.sessionId), item)
        }
        summaries.byId = byId
        summaries.at = Date.now()
        summaries.ok = true
        return true
      })
      .catch(() => {
        summaries.ok = false
        return false
      })

    // 读的是持久化，理论上可能久不返回；超时就放弃这一轮，别把刷新循环永久卡死
    let timer = null
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          /* 已经结束了 */
        }
        resolve(false)
      }, 4000)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })

    summaryInflight = Promise.race([call, guard]).then((ok) => {
      clearTimeout(timer)
      summaryInflight = null
      return ok
    })
    return summaryInflight
  }

  function buildSnapshot() {
    const now = Date.now()
    const notes = []
    if (!summaries.ok) notes.push('会话状态来自日志推断（sessionController 未就绪）')
    const rawAgents = listAgents()
    if (rawAgents === null) notes.push('agents 服务尚未就绪，暂时读不到会话')
    const agents = rawAgents || []
    const { headers, live } = sessionIndex()

    // 没见过的会话先回读日志补种（插件热装上来时，事件早就发完了）
    for (const agent of agents) {
      const id = String((agent && agent.id) || '')
      if (!id || tracks.has(id)) continue
      const session = live.get(id)
      if (session) seedSession(session)
    }

    const sessionRows = agents.map((agent) => {
      const id = String((agent && agent.id) || '')
      const record = tracks.get(id) || null
      const header = headers.get(id) || null
      const summary = summaries.byId.get(id) || null
      const session = live.get(id) || null
      const depth = Number(header && header.delegationDepth) || 0
      const title = (session && titleOf(session, record)) || (record && record.title) || ''
      if (record && title && !record.title) record.title = title
      return {
        id,
        short: shortId(id),
        running: summary ? !!summary.running : !!(record && record.running),
        resolution: summary ? 'controller' : 'log',
        kind: depth > 0 || (header && header.origin === 'subagent') ? 'sub' : 'root',
        depth,
        cwd: (header && header.cwd) || '',
        since: (record && record.since) || 0,
        title: title || shortId(id),
        last: (record && record.last) || '',
        lastKind: (record && record.lastKind) || '',
        action: record && record.action
          ? { name: record.action.name, brief: record.action.brief, at: record.action.at }
          : null,
        turns: (record && record.turns) || 0,
        tokens: (record && record.tokens) || 0,
        errors: (record && record.errors) || 0,
        updatedAt:
          (summary && Number(summary.updatedAt)) ||
          (record && record.updatedAt) ||
          Number(header && header.createdAt) ||
          0,
        blank: summary ? !!summary.blank : false,
      }
    })

    const rows = sessionRows
    rows.sort((a, b) => b.running - a.running || b.updatedAt - a.updatedAt)

    const team = collectTeam(agents)
    const jobs = collectJobs(agents)
    const goal = collectGoal(agents)

    const addresses = lanAddresses()
    const primary = addresses[0] ? addresses[0].address : '127.0.0.1'

    return {
      ok: true,
      now,
      version: VERSION,
      host: primary,
      addresses: addresses.map((a) => a.address),
      port: boundPort || port,
      stats: {
        agents: rows.length,
        running: rows.filter((r) => r.running).length,
        tasks: team.tasks.length,
        tasksActive: team.tasks.filter((t) => t.status === 'in_progress').length,
        tasksDone: team.tasks.filter((t) => t.status === 'completed').length,
        jobs: jobs.length,
        jobsRunning: jobs.filter((j) => j.status === 'running' || j.status === 'stopping').length,
      },
      goal,
      tasks: team.tasks,
      members: team.members,
      agents: rows,
      jobs,
      activity,
      notes,
    }
  }

  /* ── HTTP ── */

  let boundPort = 0

  function sendJson(res, code, body) {
    let payload
    try {
      payload = JSON.stringify(body)
    } catch (err) {
      payload = JSON.stringify({ ok: false, error: msg(err) })
      code = 500
    }
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(payload)
  }

  function authorized(req, url) {
    if (!token) return true
    const fromQuery = url.searchParams.get('k')
    if (fromQuery === token) return true
    if (req.headers['x-dsh-token'] === token) return true
    const cookie = req.headers.cookie || ''
    if (cookie.split(';').some((part) => part.trim() === `dsh_lan_token=${token}`)) return true
    return false
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'referrer-policy': 'no-referrer',
    })
    res.write(': connected\n\n')
    let lastPayload = ''
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      try {
        res.end()
      } catch {
        /* 已经断了 */
      }
    }

    const pump = () => {
      if (closed) return
      let payload
      try {
        payload = JSON.stringify(buildSnapshot())
      } catch (err) {
        payload = JSON.stringify({ ok: false, error: msg(err) })
      }
      try {
        if (payload === lastPayload) {
          res.write(': ping\n\n')
        } else {
          lastPayload = payload
          res.write(`data: ${payload}\n\n`)
        }
      } catch {
        cleanup()
      }
    }

    const timer = setInterval(pump, intervalMs)
    pump()
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('error', cleanup)
  }

  function handle(req, res) {
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    const path = url.pathname
    // HEAD 当 GET 处理（node 会把 body 丢掉）；写接口只有一个 POST /api/send
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const isSend = method === 'POST' && path === '/api/send'

    if (method !== 'GET' && !isSend) {
      res.writeHead(405, { allow: 'GET, POST' }).end('method not allowed')
      return
    }

    // 写接口只认 POST：用 GET 去点它得明确回 405，而不是含糊的 404
    if (path === '/api/send' && !isSend) {
      res.writeHead(405, { allow: 'POST' }).end('method not allowed')
      return
    }

    if (path === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' })
      res.end(ICON_SVG)
      return
    }

    if (!authorized(req, url)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<body style="background:#0b0f14;color:#e8eef6;font:15px system-ui;padding:28px;line-height:1.7">' +
          '<h3>需要访问口令</h3><p style="color:#8fa3b8">在网址后面加上 <code>?k=你的口令</code> 再打开。</p></body>',
      )
      return
    }

    if (isSend) return void handleSend(req, res)

    if (path === '/api/stream') return openStream(req, res)

    if (path === '/api/session') return void handleSession(req, res)

    if (path === '/api/image') return void handleImage(req, res)

    if (path === '/api/state') {
      try {
        sendJson(res, 200, buildSnapshot())
      } catch (err) {
        sendJson(res, 500, { ok: false, error: msg(err) })
      }
      return
    }

    if (path === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        name: NAME,
        version: VERSION,
        listening: server.listening,
        port: boundPort || port,
        host,
        urls: urls(),
        token: token ? 'required' : 'off',
        send: allowSend ? 'on' : 'off',
        sessions: tracks.size,
      })
      return
    }

    if (path === '/manifest.webmanifest') {
      sendJson(res, 200, {
        name: 'DSH 任务看板',
        short_name: '任务看板',
        start_url: token ? `/?k=${encodeURIComponent(token)}` : '/',
        display: 'standalone',
        background_color: '#0b0f14',
        theme_color: '#0b0f14',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      })
      return
    }

    if (path === '/' || path === '/index.html') {
      const html = renderPage({ version: VERSION, port: boundPort || port, host, token })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end(html)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res)
    } catch (err) {
      try {
        sendJson(res, 500, { ok: false, error: msg(err) })
      } catch {
        /* 响应已经发出去过了 */
      }
    }
  })
  server.on('clientError', (err, socket) => {
    try {
      socket.destroy()
    } catch {
      /* 已经关了 */
    }
  })

  function urls() {
    const at = boundPort || port
    return lanAddresses().map((a) => `http://${a.address}:${at}${token ? `/?k=${encodeURIComponent(token)}` : ''}`)
  }

  /* ── 会话详情 / 发消息 / 发图片：手机端也能接着聊 ── */

  /** DSH 只认这四种图片类型。 */
  const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

  /** 会话详情默认读多少条事件、最多读多少。 */
  const DETAIL_LIMIT = 80
  const DETAIL_LIMIT_MAX = 400

  /** id 精确找一个活会话（日志回读要用它自己的对象）。 */
  function findSession(id) {
    const service = svc('sessions')
    if (!service || typeof service.list !== 'function') return null
    try {
      for (const session of service.list() || []) {
        if (session && String(session.id) === id) return session
      }
    } catch {
      /* 读不到就当没有 */
    }
    return null
  }

  /** 手机端能发的会话：在看板里露过脸的都算。 */
  function knownSession(id) {
    if (!id) return false
    if (tracks.has(id)) return true
    if (summaries.byId.has(id)) return true
    return !!findSession(id)
  }

  /** 把一段 message 的 content 里的图片，变成手机能直接 <img> 的地址。 */
  function imagesOf(message, sessionId, base) {
    const out = []
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) return out
    for (const block of message.content) {
      if (!block || typeof block !== 'object' || block.type !== 'image') continue
      const ref = block.attachment || block
      const attachmentId = String((ref && ref.attachmentId) || '')
      if (!attachmentId) continue
      const mediaType = IMAGE_TYPES.has(ref.mediaType) ? ref.mediaType : 'image/png'
      out.push({
        attachmentId,
        mediaType,
        name: ref.name ? clip(ref.name, 60) : '',
        bytes: Number(ref.bytes) || 0,
        url: `${base}/image?id=${encodeURIComponent(sessionId)}&a=${encodeURIComponent(attachmentId)}`,
      })
    }
    return out
  }

  /**
   * 一条日志事件 → 手机时间线上的一行。看不懂的事件（投影、surface 之类）直接丢掉。
   * toolCallId → 工具名要靠同一个 Map 串起来，所以由调用方传进来。
   */
  function eventRecord(event, sessionId, calls, base) {
    const type = event && event.type
    const data = (event && event.data) || {}
    const seq = Number(event && event.seq) || 0
    const at = Number(event && event.time) || 0

    if (type === 'user/message') {
      const images = imagesOf(data, sessionId, base)
      const text = trimText(textOf(data), 4000)
      if (!text && !images.length) return null
      return { seq, at, kind: 'user', who: '你', text, images }
    }

    if (type === 'assistant/message') {
      const message = data.message
      const images = imagesOf(message, sessionId, base)
      const text = trimText(textOf(message), 6000)
      if (!text && !images.length) return null
      return { seq, at, kind: 'assistant', who: '助手', text, images }
    }

    if (type === 'tool/call') {
      const name = String(data.name || '工具')
      if (data.callId) calls.set(String(data.callId), name)
      return { seq, at, kind: 'tool', who: name, tool: name, brief: briefArgs(data.arguments), text: '', images: [] }
    }

    if (type === 'tool/result') {
      const callId = String((data.message && data.message.toolCallId) || data.callId || '')
      const name = calls.get(callId) || '工具'
      calls.delete(callId)
      // 正常结果不占时间线（tool/call 那行已经说明在干什么），只有出错才值得显示
      if (!data.error) return null
      const reason = data.error.message || data.error.code || data.error.name || '工具失败'
      return { seq, at, kind: 'err', who: name, text: clip(reason, 400), images: [] }
    }

    if (type === 'turn/start') {
      return { seq, at, kind: 'sys', who: '', text: `第 ${data.turn ?? '?'} 轮开始`, images: [] }
    }

    if (type === 'turn/end') {
      const reason = data.reason || {}
      if (reason.kind === 'error') {
        const detail = clip((reason.error && reason.error.message) || '', 300)
        return { seq, at, kind: 'err', who: '', text: `本轮出错${detail ? `：${detail}` : ''}`, images: [] }
      }
      return { seq, at, kind: 'sys', who: '', text: `本轮结束（${reason.kind || 'end'}）`, images: [] }
    }

    return null
  }

  /** 读多少条：手机端给个 limit，超范围的按默认来。 */
  function readLimit(req) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const raw = url.searchParams.get('limit')
      if (raw === null) return DETAIL_LIMIT
      const value = Number(raw)
      if (!Number.isInteger(value) || value <= 0) return DETAIL_LIMIT
      return Math.min(value, DETAIL_LIMIT_MAX)
    } catch {
      return DETAIL_LIMIT
    }
  }

  /**
   * 会话时间线。
   *
   * 优先读活会话自己的 snapshotEvents（插件冷启动补种用的也是它，事件形状已验证）；
   * 会话已经不在内存里（比如刚重启过、或很旧）就退回 sessionController.inspect() 的日志。
   */
  async function detailOf(id, limit, base) {
    const record = tracks.get(id)
    const session = findSession(id)
    let events = []
    let source = 'none'
    let hasMore = false

    if (session) {
      let seq = 0
      try {
        seq = Number(session.seq) || 0
      } catch {
        seq = 0
      }
      const from = Math.max(0, seq - limit)
      try {
        events = session.snapshotEvents(from, seq) || []
        source = 'live'
        hasMore = from > 0
      } catch {
        events = []
      }
    }

    if (!events.length) {
      const controller = svc('sessionController')
      if (controller && typeof controller.inspect === 'function') {
        try {
          const inspection = await controller.inspect(id)
          const all = (inspection && inspection.events) || []
          events = all.slice(Math.max(0, all.length - limit))
          source = 'inspect'
          hasMore = all.length > events.length
        } catch {
          events = []
        }
      }
    }

    const calls = new Map()
    const records = []
    for (const event of events) {
      try {
        const entry = eventRecord(event, id, calls, base)
        if (entry) records.push(entry)
      } catch {
        /* 单条坏事件不该毁掉整页 */
      }
    }

    const summary = summaries.byId.get(id)
    const title = (session && titleOf(session, record)) || (record && record.title) || ''

    return {
      ok: true,
      id,
      short: shortId(id),
      title,
      running: record ? record.running === true : !!(summary && summary.running),
      since: record ? record.since : 0,
      turns: record ? record.turns : 0,
      errors: record ? record.errors : 0,
      updatedAt: record ? record.updatedAt : Number((summary && summary.updatedAt) || 0) || 0,
      cwd: (session && session.header && typeof session.header.cwd === 'string' && session.header.cwd) || '',
      parentSessionId: String((summary && summary.parentSessionId) || '') || '',
      allowSend: allowSend === true,
      canSend: allowSend === true && !!(svc('sessionController') && typeof svc('sessionController').prompt === 'function'),
      maxImages,
      maxImageBytes,
      source,
      limit,
      hasMore,
      count: records.length,
      records,
      fetchedAt: Date.now(),
    }
  }

  function attachmentOf(id, attachmentId) {
    const controller = svc('sessionController')
    if (!controller || typeof controller.attachment !== 'function') return null
    return controller.attachment({ sessionId: id, attachmentId })
  }

  /** 读 JSON 请求体，顺手把超长请求掐掉。 */
  function readJsonBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      let done = false
      const fail = (err) => {
        if (done) return
        done = true
        reject(err)
        try {
          req.destroy()
        } catch {
          /* 已经断了 */
        }
      }
      req.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > limit) {
          fail(Object.assign(new Error(`请求体太大（上限 ${Math.round(limit / 1024 / 1024)} MB）`), { code: 'too-large' }))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (done) return
        done = true
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.trim()) {
          resolve({})
          return
        }
        try {
          const parsed = JSON.parse(raw)
          resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', (err) => fail(err))
    })
  }

  /** 校验一张待发图片，返回 { value } 或 { error }。 */
  function imagePart(image) {
    if (!image || typeof image !== 'object') return { error: '图片格式不对' }
    const mediaType = String(image.mediaType || '')
    if (!IMAGE_TYPES.has(mediaType)) {
      return { error: `只支持 png / jpeg / webp / gif，收到「${mediaType || '空类型'}」` }
    }
    let data = String(image.data || '')
    if (data.startsWith('data:')) {
      const comma = data.indexOf(',')
      if (comma >= 0) data = data.slice(comma + 1)
    }
    data = data.replace(/\s+/g, '')
    if (!data) return { error: '图片内容是空的' }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: '图片数据不是合法 base64' }
    const bytes = Buffer.from(data, 'base64').length
    if (!bytes) return { error: '图片数据解出来是空的' }
    if (bytes > maxImageBytes) {
      const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10
      return { error: `单张图片最大 ${mb(maxImageBytes)} MB，这张 ${mb(bytes)} MB` }
    }
    const part = { type: 'image', mediaType, data }
    const name = trimText(image.name, 60)
    if (name) part.name = name
    return { value: part }
  }

  let sendCounter = 0

  /** POST /api/send：等价于在桌面输入框里敲一句话，可以带图。 */
  async function handleSend(req, res) {
    try {
      if (!allowSend) {
        sendJson(res, 403, { ok: false, error: '插件关掉了发送功能（config.allowSend = false）' })
        return
      }
      const contentType = String(req.headers['content-type'] || '')
      if (!contentType.toLowerCase().startsWith('application/json')) {
        // 强制 JSON：跨站表单没法伪造这个 Content-Type，等于顺手挡了 CSRF
        sendJson(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' })
        return
      }
      const controller = svc('sessionController')
      if (!controller || typeof controller.prompt !== 'function') {
        sendJson(res, 503, { ok: false, error: '会话服务不可用，现在发不出去' })
        return
      }

      let body
      try {
        body = await readJsonBody(req, maxBodyBytes)
      } catch (err) {
        sendJson(res, err && err.code === 'too-large' ? 413 : 400, { ok: false, error: msg(err) })
        return
      }

      const sessionId = String((body && body.sessionId) || '').trim()
      if (!sessionId) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        return
      }
      if (!knownSession(sessionId)) {
        sendJson(res, 404, { ok: false, error: '找不到这个会话，刷新一下页面再试' })
        return
      }

      const content = []
      const text = trimText(body.text, 20000)
      if (text) content.push({ type: 'text', text })

      const incoming = Array.isArray(body.images) ? body.images : []
      if (incoming.length > maxImages) {
        sendJson(res, 400, { ok: false, error: `一条消息最多 ${maxImages} 张图，收到 ${incoming.length} 张` })
        return
      }
      for (const image of incoming) {
        const checked = imagePart(image)
        if (checked.error) {
          sendJson(res, 400, { ok: false, error: checked.error })
          return
        }
        content.push(checked.value)
      }
      if (!content.length) {
        sendJson(res, 400, { ok: false, error: '消息是空的：写点字或者选张图' })
        return
      }

      const mode = body.mode === 'steer' ? 'steer' : 'queue'
      sendCounter += 1
      const requestId = `lan-tasks-${Date.now().toString(36)}-${sendCounter}`
      const request = {
        requestId,
        sessionId,
        mode,
        content,
        ...(typeof body.tz === 'string' && body.tz.trim() ? { clientTimeZone: body.tz.trim() } : {}),
      }

      const abort = new AbortController()
      const timer = setTimeout(() => {
        try {
          abort.abort()
        } catch {
          /* 已经结束了 */
        }
      }, 20000)
      if (timer && typeof timer.unref === 'function') timer.unref()

      let value
      try {
        value = await controller.prompt(request, abort.signal)
      } catch (err) {
        sendJson(res, 502, { ok: false, error: `发送失败：${msg(err)}`, sessionId, requestId })
        return
      } finally {
        clearTimeout(timer)
      }

      const record = track(sessionId)
      record.since = record.since || Date.now()
      record.lastKind = 'user'
      if (text) record.last = clip(text, 220)
      feed(sessionId, 'user', text || `[图片 ×${content.length}]`, '你（手机）')

      sendJson(res, 200, {
        ok: true,
        accepted: !!(value && value.accepted),
        sessionId,
        mode,
        requestId,
        parts: content.length,
        images: content.length - (text ? 1 : 0),
      })
    } catch (err) {
      try {
        sendJson(res, 500, { ok: false, error: msg(err) })
      } catch {
        /* 响应已经发出去了 */
      }
    }
  }

  /** GET /api/session?id=…：手机端点进会话看的那份时间线。 */
  async function handleSession(req, res) {
    try {
      const base = '/api'
      const url = new URL(req.url || '/', 'http://localhost')
      const id = String(url.searchParams.get('id') || '').trim()
      if (!id) {
        sendJson(res, 400, { ok: false, error: '缺少 id 参数' })
        return
      }
      if (!knownSession(id)) {
        sendJson(res, 404, { ok: false, error: '找不到这个会话（可能已经被删了）' })
        return
      }
      sendJson(res, 200, await detailOf(id, readLimit(req), base))
    } catch (err) {
      try {
        sendJson(res, 500, { ok: false, error: msg(err) })
      } catch {
        /* 响应已经发出去了 */
      }
    }
  }

  /** GET /api/image?id=…&a=…：把会话日志里的图片转成 <img> 能用的字节。 */
  async function handleImage(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const id = String(url.searchParams.get('id') || '').trim()
      const attachmentId = String(url.searchParams.get('a') || '').trim()
      if (!id || !attachmentId) {
        sendJson(res, 400, { ok: false, error: '需要 id 和 a 两个参数' })
        return
      }
      const pending = attachmentOf(id, attachmentId)
      if (!pending) {
        sendJson(res, 503, { ok: false, error: '会话服务不可用，读不了图片' })
        return
      }
      const value = await pending
      const ref = (value && value.attachment) || {}
      const mediaType = IMAGE_TYPES.has(ref.mediaType) ? ref.mediaType : 'image/png'
      let data = String((value && value.data) || '')
      if (data.startsWith('data:')) {
        const comma = data.indexOf(',')
        if (comma >= 0) data = data.slice(comma + 1)
      }
      const bytes = Buffer.from(data, 'base64')
      if (!bytes.length) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('empty attachment')
        return
      }
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
    } catch (err) {
      try {
        sendJson(res, 502, { ok: false, error: `读图片失败：${msg(err)}` })
      } catch {
        /* 响应已经发出去了 */
      }
    }
  }

  /* ── 桌面 GUI 面板：挂到宿主 webServer，和 GUI 同源 ── */

  const PANEL_BASE = '/lan-tasks'

  /** 面板要展示的局域网入口：完整 URL（带 token）+ 对应二维码地址。 */
  function panelAddresses() {
    const at = boundPort || port
    const tail = token ? `/?k=${encodeURIComponent(token)}` : '/'
    return lanAddresses().map((a, i) => ({
      index: i,
      name: a.name,
      address: a.address,
      url: `http://${a.address}:${at}${tail}`,
      qr: `${PANEL_BASE}/qr.svg?i=${i}`,
    }))
  }

  /** 选一个地址生成二维码：索引越界退回第一个；一个局域网地址都没有就返回 undefined。 */
  function qrTarget(index) {
    const list = panelAddresses()
    if (!list.length) return undefined
    return list[index] || list[0]
  }

  /** 面板整体状态。快照读失败也要回一份能显示的 JSON，面板不能白屏。 */
  function panelState() {
    let snapshot = { stats: {}, notes: [] }
    try {
      snapshot = buildSnapshot()
    } catch (err) {
      snapshot = { stats: {}, notes: [msg(err)] }
    }
    const at = boundPort || port
    const tail = token ? `/?k=${encodeURIComponent(token)}` : '/'
    return {
      ok: true,
      name: NAME,
      version: VERSION,
      listening: server.listening === true,
      port: at,
      host,
      token: token ? 'required' : 'off',
      localUrl: `http://127.0.0.1:${at}${tail}`,
      addresses: panelAddresses(),
      stats: snapshot.stats || {},
      notes: snapshot.notes || [],
      sessions: tracks.size,
      updatedAt: Date.now(),
    }
  }

  function readIndex(req) {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const raw = url.searchParams.get('i')
      if (raw === null) return 0
      const value = Number(raw)
      return Number.isInteger(value) && value >= 0 ? value : 0
    } catch {
      return 0
    }
  }

  const web = svc('webServer')
  if (web && typeof web.register === 'function') {
    const route = (pathname, handler) => ctx.effect(() => web.register({ kind: 'exact', path: pathname, handler }))

    route(`${PANEL_BASE}/state`, (req, res) => {
      try {
        sendJson(res, 200, panelState())
      } catch (err) {
        sendJson(res, 500, { ok: false, error: msg(err) })
      }
    })

    route(`${PANEL_BASE}/qr.svg`, (req, res) => {
      const target = qrTarget(readIndex(req))
      if (!target) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no lan address')
        return
      }
      let svg
      try {
        svg = qrSvg(target.url)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(msg(err))
        return
      }
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(svg)
    })

    route(`${PANEL_BASE}/qr.txt`, (req, res) => {
      const target = qrTarget(readIndex(req))
      if (!target) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('no lan address')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`${target.url}\n\n${qrAscii(target.url)}`)
    })
  } else {
    // eslint-disable-next-line no-console
    console.error(`[${NAME}] 宿主没有 webServer，桌面 GUI 面板不可用（手机页面不受影响）。`)
  }

  function banner() {
    const list = urls()
    const lines = [
      '',
      `  ${NAME} v${VERSION} · 局域网任务看板已启动`,
      '  ────────────────────────────────────────────',
    ]
    if (list.length) {
      lines.push(`  手机打开：  ${list[0]}`)
      for (const extra of list.slice(1)) lines.push(`  备用地址：  ${extra}`)
    } else {
      lines.push('  没找到局域网 IPv4，检查一下网卡')
    }
    lines.push(`  本机打开：  http://127.0.0.1:${boundPort || port}`)
    lines.push(`  自检接口：  http://127.0.0.1:${boundPort || port}/healthz`)
    if (allowSend) lines.push('  手机端：    可以点进会话看，也能发消息 / 发图片')
    lines.push('  ────────────────────────────────────────────')
    if (allowSend && !token) {
      lines.push('  ⚠ 手机端能发消息，但没设访问口令（config.token）。')
      lines.push('    同网段的人打开这个地址，就能指挥这台机器上的 agent 干活。')
      lines.push('    公用网络请补上 token，或把 config.allowSend 改成 false。')
      lines.push('')
    }
    // 终端里直接打一张二维码：手机相机对着屏幕就能扫
    if (list.length && process.stdout && process.stdout.isTTY) {
      try {
        lines.push('  扫码打开（手机相机对着下面这张）：')
        lines.push(qrAscii(list[0]))
      } catch (err) {
        lines.push(`  （二维码生成失败：${msg(err)}）`)
      }
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))
  }

  const teardown = () => {
    unsubscribe()
    clearInterval(summaryTimer)
    try {
      server.close()
    } catch {
      /* 没起来 */
    }
  }

  const unsubscribe = subscribe()

  // 权威会话状态放后台刷新，快照只读缓存；unref 掉，别拖着宿主进程不放
  const summaryTimer = setInterval(() => {
    void refreshSummaries()
  }, Math.max(1000, Math.min(intervalMs, 3000)))
  if (typeof summaryTimer.unref === 'function') summaryTimer.unref()
  void refreshSummaries()

  ctx.effect(() => {
    server.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[${NAME}] HTTP 服务出错：${msg(err)}`)
      if (err && err.code === 'EADDRINUSE') {
        // eslint-disable-next-line no-console
        console.error(`[${NAME}] 端口 ${port} 被占用了，改一下插件 config.port 再重启。`)
      }
    })
    server.listen(port, host, () => {
      const address = server.address()
      if (address && typeof address === 'object') boundPort = address.port
      banner()
    })
    return teardown
  })
}
