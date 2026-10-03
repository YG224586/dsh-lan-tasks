/**
 * 离线冒烟测试（手机页面）：不开浏览器，用假 DOM 跑 page.js 里的页面脚本，
 * 让它真的通过 HTTP 打到插件实例上，验证「点进会话 → 看时间线/图片 → 发消息 / 发图片」。
 *
 * 用法： node smoke-page.mjs [port]
 */
import vm from 'node:vm'
import { apply } from './index.js'
import { renderPage } from './page.js'

const PORT = Number(process.argv[2] || 8879)
const TOKEN_PORT = PORT + 1
const TOKEN = 's3cr3t-token-0123456789'
const originOf = (port) => `http://127.0.0.1:${port}`

/* ── 假数据：形状照着真契约 ── */
const leadId = 'session-lead-0001'
const now = Date.now()
const IMG_BYTES = Buffer.from('89504e470d0a1a0a0000000d', 'hex')
const IMG_B64 = IMG_BYTES.toString('base64')
/* 假 canvas 一定会压出这一串，用它可以断言「手机发出去的是压缩后的图」 */
const SHRUNK_B64 = Buffer.from('jpeg-after-shrink').toString('base64')

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
let total = 0
const check = (label, ok, extra) => {
  total += 1
  if (!ok) {
    failed += 1
    console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`)
  }
}

/* ── 每个实例一份假 ctx：记录 prompt 调用，方便断言「手机发出去的到底是什么」 ── */
function makeInstance() {
  const prompts = []
  const live = {
    id: leadId,
    header: { version: 1, id: leadId, createdAt: now - 60000, cwd: 'C:\\work', isSeeded: false },
    seq: leadEvents[leadEvents.length - 1].seq,
    snapshotEvents: (from, to) => leadEvents.filter((e) => e.seq > from && e.seq <= to),
  }
  const web = {
    routes: new Map(),
    register(entry) {
      web.routes.set(entry.path, entry)
      return () => web.routes.delete(entry.path)
    },
  }
  const services = {
    webServer: web,
    agents: { list: () => [{ id: leadId }], roots: () => [{ id: leadId }] },
    sessions: { list: () => [live] },
    agentTeams: {
      tryMembership: () => ({ root: { id: leadId }, id: 'team-1', role: 'lead', name: 'lead' }),
      listMembers: () => [{ id: leadId, name: 'lead', role: 'lead', status: 'running', description: '统筹全局' }],
      listTasks: () => [],
    },
    jobs: { list: () => [] },
    goals: { get: () => null },
    sessionController: {
      list: async () => ({
        items: [{ agentAvailable: true, sessionId: leadId, updatedAt: now - 1000, running: true, blank: false, cwd: 'C:\\work' }],
      }),
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
      attachment: async () => ({
        attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: IMG_BYTES.length, width: 2, height: 2, name: 'shot.png' },
        data: IMG_B64,
      }),
      inspect: async (id) => ({ meta: { version: 1, id, createdAt: now - 90000 }, inheritedEventCount: 0, events: [] }),
    },
    sessionTitle: { get: () => ({ title: '局域网插件主线' }) },
  }
  const handlers = new Map()
  const dispose = []
  const ctx = {
    get: (name) => services[name],
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') dispose.push(d)
      return () => {}
    },
  }
  return { ctx, prompts }
}

async function healthz(port, token) {
  const suffix = token ? `?k=${encodeURIComponent(token)}` : ''
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${originOf(port)}/healthz${suffix}`)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await wait(50)
  }
  return false
}

/* ── 假 DOM ── */
function makeElement(id, attrs) {
  const el = {
    id: id || '', innerHTML: '', textContent: '', className: '', value: '',
    style: {}, scrollTop: 0, scrollHeight: 1000, clientHeight: 400, files: null,
    attrs: attrs || {},
    classList: { add() {}, remove() {}, contains: () => false },
    handlers: {},
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn) },
    getAttribute(name) { return name in el.attrs ? el.attrs[name] : null },
    setAttribute(name, value) { el.attrs[name] = value },
    querySelector() { return { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 } },
    parentNode: null,
  }
  return el
}
function makeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toDataURL: () => `data:image/jpeg;base64,${SHRUNK_B64}`,
  }
}
/** 用来模拟「点到了列表里的某个元素」：事件的 target 只带属性。 */
const tap = (attrs) => ({ parentNode: null, id: '', value: '', getAttribute: (name) => (name in attrs ? attrs[name] : null) })

class FakeFileReader {
  readAsDataURL(file) {
    const type = (file && file.type) || 'image/png'
    this.result = `data:${type};base64,${(file && file.__data) || ''}`
    queueMicrotask(() => { if (this.onload) this.onload() })
  }
}
class FakeImage {
  constructor() { this.width = 0; this.height = 0; this.onload = null; this.onerror = null }
  set src(value) {
    this._src = value
    queueMicrotask(() => { this.width = 2400; this.height = 1200; if (this.onload) this.onload() })
  }
  get src() { return this._src }
}

const html = renderPage({ version: '1.3.0', port: PORT, host: '127.0.0.1', token: '' })
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'))

async function loadPage({ port, search = '', failSession = false }) {
  const elements = new Map()
  for (const id of ['app', 'dot', 'clock', 'link', 'sheet']) elements.set(id, makeElement(id))
  const docHandlers = new Map()
  const document = {
    hidden: false,
    activeElement: null,
    body: makeElement('body'),
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : makeElement(tag)),
    addEventListener(type, fn) {
      if (!docHandlers.has(type)) docHandlers.set(type, [])
      docHandlers.get(type).push(fn)
    },
  }
  const calls = []
  const intervals = []
  const sandbox = {
    console,
    document,
    location: { search, href: `${originOf(port)}/${search}` },
    setInterval(fn, ms) { intervals.push(ms); return intervals.length },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    FileReader: FakeFileReader,
    Image: FakeImage,
    fetch(url, init) {
      const target = new URL(String(url), originOf(port))
      calls.push({ url: String(url), path: target.pathname, query: target.search, init: init || {} })
      if (failSession && target.pathname === '/api/session') {
        return Promise.resolve(new Response(JSON.stringify({ ok: false, error: '会话服务炸了' }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }))
      }
      return fetch(target.href, init)
    },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(script, sandbox, { filename: 'page-script.js' })
  await wait(250)
  const dispatch = (type, event) => { for (const fn of docHandlers.get(type) || []) fn(event) }
  return { sandbox, elements, calls, intervals, dispatch, document }
}

/* ── 起两个实例：一个没口令，一个带口令 ── */
const plain = makeInstance()
apply(plain.ctx, { port: PORT, host: '127.0.0.1', history: 20, intervalMs: 800 })
check('实例 A 起来了（/healthz）', await healthz(PORT))

const guarded = makeInstance()
apply(guarded.ctx, { port: TOKEN_PORT, host: '127.0.0.1', token: TOKEN, history: 20, intervalMs: 800 })
check('实例 B 起来了（带口令）', await healthz(TOKEN_PORT, TOKEN))

/* ── 1. 首页 → 点进会话 ── */
const page = await loadPage({ port: PORT })
const app = () => page.elements.get('app').innerHTML
const sheet = () => page.elements.get('sheet')
const state = () => page.sandbox.window.__lan.state

check('页面脚本跑起来了（window.__lan）', !!(page.sandbox.window && page.sandbox.window.__lan))
check('首页把会话列成可点条目', app().includes('data-act="open"') && app().includes(`data-sid="${leadId}"`))
check('条目带 › 箭头', app().includes('class="chev"'))
check('没连上 SSE 时按 2500ms 轮询', page.intervals.includes(2500))
check('首帧读到了状态', !app().includes('正在读取状态'))

page.dispatch('click', { target: tap({ 'data-act': 'open', 'data-sid': leadId }), preventDefault() {} })
await wait(300)

const detailCall = page.calls.find((c) => c.path === '/api/session')
check('点一下会去读会话详情', !!detailCall, JSON.stringify(page.calls.map((c) => c.url)))
check('详情请求带上了会话 id', !!detailCall && detailCall.query.includes(`id=${leadId}`))
check('详情请求带口令（当前没有口令，不该乱加）', !!detailCall && !detailCall.query.includes('k='))
check('详情请求带 credentials/cache 约束', !!detailCall && detailCall.init.credentials === 'same-origin' && detailCall.init.cache === 'no-store')
check('浮层打开了', sheet().style.display === 'flex')
check('标题是会话标题', sheet().innerHTML.includes('局域网插件主线'))
check('状态行说是实时日志', sheet().innerHTML.includes('实时日志'))
check('时间线里有我说的话', sheet().innerHTML.includes('帮我看下任务情况'))
check('时间线里有助手的回复', /class="msg assistant"/.test(sheet().innerHTML) && sheet().innerHTML.includes('装好了'))
check('工具调用显示成一行', /class="msg tool"/.test(sheet().innerHTML) && sheet().innerHTML.includes('bash pnpm install'))
check('工具报错显示成红行', /class="msg err"/.test(sheet().innerHTML) && sheet().innerHTML.includes('命令失败'))
check('历史里的图片走 /api/image 代理', sheet().innerHTML.includes('/api/image?') && sheet().innerHTML.includes('a=att-1'))
check('输入区有文本框/选图/发送', sheet().innerHTML.includes('id="draft"') && sheet().innerHTML.includes('id="pick"') && sheet().innerHTML.includes('data-act="send"'))
check('从列表点进来的请求没重复', page.calls.filter((c) => c.path === '/api/session').length === 1)

/* ── 2. 空内容不让发 ── */
page.dispatch('click', { target: tap({ 'data-act': 'send' }), preventDefault() {} })
await wait(120)
check('空内容不会发出去', plain.prompts.length === 0)
check('空内容时页面有提示', sheet().innerHTML.includes('写点字'))

/* ── 3. 打字 → 发送 ── */
page.dispatch('input', { target: { id: 'draft', value: '从手机发的' } })
check('打字进草稿', state().draft === '从手机发的')
page.dispatch('click', { target: tap({ 'data-act': 'send' }), preventDefault() {} })
await wait(300)
const sent = plain.prompts[0]
check('服务端收到一条 prompt', plain.prompts.length === 1)
check('发给的是这个会话', !!sent && sent.sessionId === leadId)
check('内容就是那段文字', !!sent && sent.content.length === 1 && sent.content[0].type === 'text' && sent.content[0].text === '从手机发的')
check('mode 默认 queue', !!sent && sent.mode === 'queue')
check('requestId 形如 lan-tasks-…', !!sent && /^lan-tasks-/.test(sent.requestId))
check('带了手机时区', !!sent && typeof sent.clientTimeZone === 'string' && sent.clientTimeZone.length > 0)
check('发完提示已发送', sheet().innerHTML.includes('已发送'))
check('发完草稿清空', state().draft === '')

/* ── 4. 选图：本地先压 ── */
const png = { name: 'a.png', type: 'image/png', size: 12, __data: 'iVBORw0KGgo=' }
page.sandbox.window.__lan.pick([png])
await wait(250)
check('选中的图被压成 jpeg', state().images.length === 1 && state().images[0].mediaType === 'image/jpeg' && state().images[0].data === SHRUNK_B64)
check('缩略图是 data URL', state().images.length === 1 && state().images[0].url.indexOf('data:image/jpeg;base64,') === 0)
check('浮层里有图片 chip', sheet().innerHTML.includes('class="chip"'))

page.sandbox.window.__lan.pick([{ name: 'a.txt', type: 'text/plain' }])
await wait(80)
check('非图片会被拒', state().sendError === '只能选图片')
check('被拒的文件没进列表', state().images.length === 1)

page.sandbox.window.__lan.pick([png, png, png, png, png])
await wait(250)
check('超过张数上限会给提示，且不会被打字/读图冲掉', /只收了前 3 张/.test(sheet().innerHTML), sheet().innerHTML.slice(-320))
check('多出来的图确实没进去', state().images.length === 4)
while (state().images.length > 1) {
  page.dispatch('click', { target: tap({ 'data-act': 'drop', 'data-i': '0' }), preventDefault() {} })
}
check('可以删掉选错的图', state().images.length === 1)

/* ── 5. 文字 + 图片一起发 ── */
page.dispatch('input', { target: { id: 'draft', value: '看这张' } })
page.dispatch('click', { target: tap({ 'data-act': 'send' }), preventDefault() {} })
await wait(300)
const withImg = plain.prompts[plain.prompts.length - 1]
check('图片和文字一起发出去', plain.prompts.length === 2 && !!withImg && withImg.content.length === 2, JSON.stringify(withImg && withImg.content.map((p) => p.type)))
check('发出去的是压缩后的 jpeg', !!withImg && withImg.content[1].type === 'image' && withImg.content[1].mediaType === 'image/jpeg')
check('图片数据与压缩结果一致', !!withImg && withImg.content[1].data === SHRUNK_B64)
check('图片名字一起带上', !!withImg && withImg.content[1].name === 'a.png')
check('发完清空图片', state().images.length === 0)
check('发完提示已发送', sheet().innerHTML.includes('已发送'))

/* ── 6. Esc 关浮层 ── */
page.dispatch('keydown', { key: 'Escape' })
check('Esc 能关掉浮层', sheet().style.display === 'none' && sheet().innerHTML === '')

/* ── 7. 接口挂了要能看出来 ── */
const broken = await loadPage({ port: PORT, failSession: true })
broken.dispatch('click', { target: tap({ 'data-act': 'open', 'data-sid': leadId }), preventDefault() {} })
await wait(300)
check('读会话失败时把原因显示出来', broken.elements.get('sheet').innerHTML.includes('会话服务炸了'))

/* ── 8. 带口令的那台：所有请求都要带上 k ── */
const guardedPage = await loadPage({ port: TOKEN_PORT, search: `?k=${TOKEN}` })
guardedPage.dispatch('click', { target: tap({ 'data-act': 'open', 'data-sid': leadId }), preventDefault() {} })
await wait(300)
check('带口令时每个请求都带 k=', guardedPage.calls.length > 1 && guardedPage.calls.every((c) => c.query.includes(`k=${TOKEN}`)), JSON.stringify(guardedPage.calls.map((c) => c.query)))
check('带口令也能读到详情', guardedPage.elements.get('sheet').innerHTML.includes('实时日志'))
guardedPage.dispatch('input', { target: { id: 'draft', value: '带口令发的' } })
guardedPage.dispatch('click', { target: tap({ 'data-act': 'send' }), preventDefault() {} })
await wait(300)
check('带口令也能发消息', guarded.prompts.length === 1 && guarded.prompts[0].content[0].text === '带口令发的')
check('带口令发送也走 JSON 头', guardedPage.calls.some((c) => c.path === '/api/send' && c.init.method === 'POST' && c.init.headers && c.init.headers['content-type'] === 'application/json'))

console.log(`${failed} 项失败 / 共 ${total} 项`)
process.exit(failed ? 1 : 0)
