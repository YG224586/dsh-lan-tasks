/**
 * 离线冒烟测试（浏览器半边）：不开 DSH，也不开浏览器，
 * 用假的 window.__ModuleLoader__ + 迷你 React + 假 fetch 把 client.js 跑起来，
 * 验证：能注册三个槽、面板能渲染出二维码/链接/统计、点击能切地址与复制、坏数据不白屏。
 *
 * 注意：迷你 React 只在渲染时同步跑一次 useEffect（真 React 是渲染提交后才跑），
 * 这样测试才能在一次 render + 一次 await 之后看到 fetch 的结果。
 *
 * 用法： node smoke-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}
const tick = () => new Promise((r) => setTimeout(r, 0))

/* ── 迷你 React：够 client.js 用（useState 跨渲染持久化，useEffect/useCallback/useRef） ── */

const components = new Map()
let current = null

function render(Component, props) {
  if (!components.has(Component)) components.set(Component, { states: [], refs: [], cursor: 0 })
  const rec = components.get(Component)
  const prev = current
  current = rec
  rec.cursor = 0
  try {
    return Component(props || {})
  } finally {
    current = rec === prev ? prev : prev
  }
}

function createElement(type, props, ...children) {
  const kids = children.length <= 1 ? children[0] : children
  return { $$el: true, type, props: Object.assign({}, props || {}, { children: kids }) }
}

const React = {
  createElement,
  useState(initial) {
    const rec = current
    const i = rec.cursor++
    if (!(i in rec.states)) rec.states[i] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      rec.states[i] = typeof value === 'function' ? value(rec.states[i]) : value
    }
    return [rec.states[i], set]
  },
  useEffect(fn) {
    current.cursor += 1
    fn()
  },
  useCallback(fn) {
    current.cursor += 1
    return fn
  },
  useRef(value) {
    const rec = current
    const i = rec.cursor++
    if (!(i in rec.refs)) rec.refs[i] = { current: value }
    return rec.refs[i]
  },
}

/* ── 迷你 DOM / 宿主环境 ── */

const intervals = []
const listeners = new Map()
const appended = []
const clipboard = { text: '', writeText: async (value) => { clipboard.text = value } }

const sandbox = {
  console,
  React,
  setInterval: (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  },
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  document: {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    createElement: (tag) => ({ tag, style: {}, setAttribute() {}, select() {} }),
    body: { appendChild: (node) => appended.push(node), removeChild() {} },
    execCommand: () => false,
  },
  navigator: { clipboard },
  fetch: null,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

/* ── 加载 client.js（classic script，走 __ModuleLoader__） ── */

let declared = null
sandbox.window.__ModuleLoader__ = {
  load(decl) {
    declared = decl
  },
}

const source = readFileSync(join(HERE, 'client.js'), 'utf8')
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

check('client.js 用 __ModuleLoader__.load 注册', !!declared && typeof declared.factory === 'function', declared && declared.id)

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
check('注册 id 与包名一致', declared.id === pkg.name, `${declared.id} vs ${pkg.name}`)

let required = []
const plugin = declared.factory((id) => {
  required.push(id)
  if (id === 'react') return React
  throw new Error(`测试里没有这个模块：${id}`)
})
check('只依赖 react 这一个内置模块', required.length === 1 && required[0] === 'react', required.join(','))
check('插件导出 inject/apply', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && typeof plugin.apply === 'function')

/* ── 假 slots 容器：接管 inject / register ── */

const injected = []
const registered = []
const ctx = {
  slots: {
    inject(name, fn) {
      injected.push({ name, fn })
    },
    register(config, Component) {
      registered.push({ config, Component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

check('注册了三个槽', injected.length === 3, injected.map((i) => i.name).join(' '))
check(
  '槽名符合预期',
  JSON.stringify(injected.map((i) => i.name)) === JSON.stringify(['settings.section', 'sidebar.footer.action', 'shell.overlay']),
  injected.map((i) => i.name).join(','),
)

for (const item of injected) item.fn()
check('三个槽都拿到了组件', registered.length === 3 && registered.every((r) => typeof r.Component === 'function'))
check(
  '注册项 id / order 正确',
  registered.every((r) => r.config.id === 'lan-tasks' && typeof r.config.order === 'number') &&
    registered[0].config.name === 'settings.section' &&
    registered[0].config.label === '局域网任务看板' &&
    registered[1].config.label === '局域网看板',
  registered.map((r) => `${r.config.name}:${r.config.id}@${r.config.order}`).join(' '),
)

const [SettingsSection, FooterAction, OverlayHost] = registered.map((r) => r.Component)

/* ── 树工具：把函数组件就地展开成宿主元素 ── */

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (typeof node === 'object' && node.$$el) {
    if (typeof node.type === 'function') return collect(render(node.type, node.props), out)
    out.push(node)
    collect(node.props.children, out)
  }
  return out
}

function textOf(node) {
  const parts = []
  const visit = (n) => {
    if (n === null || n === undefined || typeof n === 'boolean') return
    if (Array.isArray(n)) {
      n.forEach(visit)
      return
    }
    if (typeof n === 'object' && n.$$el) {
      if (typeof n.type === 'function') visit(render(n.type, n.props))
      else visit(n.props.children)
      return
    }
    parts.push(String(n))
  }
  visit(node)
  return parts.join(' ')
}

const find = (node, pred) => collect(node).filter(pred)
const byType = (node, type) => find(node, (el) => el.type === type)
const buttonWith = (node, label) => find(node, (el) => el.type === 'button' && textOf(el) === label)[0]

/* ── 假面板数据（形状抄 Host 的 /lan-tasks/state） ── */

const payload = {
  ok: true,
  name: 'dsh-lan-tasks',
  version: pkg.version,
  listening: true,
  port: 8791,
  host: '0.0.0.0',
  token: 'off',
  localUrl: 'http://127.0.0.1:8791/',
  addresses: [
    { index: 0, name: 'Wi-Fi', address: '192.168.1.32', url: 'http://192.168.1.32:8791/', qr: '/lan-tasks/qr.svg?i=0' },
    { index: 1, name: '以太网', address: '10.0.0.7', url: 'http://10.0.0.7:8791/', qr: '/lan-tasks/qr.svg?i=1' },
  ],
  stats: { agents: 2, running: 1, tasks: 4, tasksActive: 2, tasksDone: 1, jobs: 3, jobsRunning: 1 },
  notes: ['运行状态取自 sessionController'],
  sessions: 2,
  updatedAt: 1700000000000,
}

const calls = []
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
let answer = async () => response(payload)
sandbox.fetch = (url, options) => {
  calls.push({ url, options })
  return answer(url, options)
}

/* ── 面板渲染：先无数据，再等 fetch 落地重渲染 ── */

const first = render(SettingsSection, {})
check('首帧是加载中', textOf(first).includes('正在读取'), textOf(first).slice(0, 40))
check('请求的是同源面板接口', calls.length >= 1 && calls[0].url === '/lan-tasks/state', JSON.stringify(calls[0] || {}))
check(
  '请求带同源凭据且不缓存',
  calls[0].options.credentials === 'same-origin' && calls[0].options.cache === 'no-store',
  JSON.stringify(calls[0].options),
)
check('按 5 秒轮询', intervals.length >= 1 && intervals[0].ms === 5000, `intervals=${intervals.length} ms=${intervals[0] && intervals[0].ms}`)

await tick()
const tree = render(SettingsSection, {})
const text = textOf(tree)
const images = byType(tree, 'img')

check('渲染出二维码图片', images.length === 1 && images[0].props.src === '/lan-tasks/qr.svg?i=0', images[0] && images[0].props.src)
check('二维码图片可访问性描述带地址', !!images[0] && String(images[0].props.alt).includes('192.168.1.32'), images[0] && images[0].props.alt)
check('图片有显式尺寸（不跳版）', !!images[0] && images[0].props.width === images[0].props.height && images[0].props.width > 100, images[0] && String(images[0].props.width))
check('显示完整入口 URL', text.includes('http://192.168.1.32:8791/'), text.slice(0, 120))
check('状态行带版本与端口', text.includes(`dsh-lan-tasks v${pkg.version}`) && text.includes('端口 8791'))
check('统计六项都在', ['会话', '运行中', '任务', '进行中', '已完成', '作业'].every((label) => text.includes(label)))
check('统计数值来自接口', text.includes('2 会话') && text.includes('2 进行中') && text.includes('1 已完成') && text.includes('3 作业'), text.replace(/\s+/g, ' ').slice(0, 200))
check('宿主提示原样显示', text.includes('运行状态取自 sessionController'))
check('本机入口提示', text.includes('http://127.0.0.1:8791/'))
check('复制按钮在', !!buttonWith(tree, '复制链接'))
check('刷新按钮在', !!buttonWith(tree, '刷新'))
check('本机打开是普通链接', byType(tree, 'a')[0] && byType(tree, 'a')[0].props.href === 'http://192.168.1.32:8791/', byType(tree, 'a')[0] && byType(tree, 'a')[0].props.href)

/* ── 多网卡：切地址 ── */

const chips = find(tree, (el) => el.type === 'button' && /^(192\.168\.1\.32|10\.0\.0\.7)$/.test(textOf(el)))
check('多网卡给出切换按钮', chips.length === 2, chips.map((c) => textOf(c)).join(' '))
chips[1].props.onClick()
const tree2 = render(SettingsSection, {})
check('切换后二维码跟着换', byType(tree2, 'img')[0].props.src === '/lan-tasks/qr.svg?i=1', byType(tree2, 'img')[0].props.src)
check('切换后 URL 跟着换', textOf(tree2).includes('http://10.0.0.7:8791/'))

/* ── 复制 ── */

await buttonWith(tree2, '复制链接').props.onClick()
await tick()
check('复制到剪贴板', clipboard.text === 'http://10.0.0.7:8791/', clipboard.text)
check('复制后按钮变成已复制', textOf(render(SettingsSection, {})).includes('已复制'))

/* ── 侧栏按钮 + 浮层 ── */

const wide = render(FooterAction, { wide: true })
check('宽栏按钮带文字', textOf(wide).includes('局域网看板'), textOf(wide))
const narrow = render(FooterAction, { wide: false })
check('窄栏按钮只剩图标', textOf(narrow).trim() === '' && byType(narrow, 'svg').length === 1, `text=${JSON.stringify(textOf(narrow))}`)
check('窄栏按钮有 title', String(narrow.props.title).includes('局域网任务看板'), narrow.props.title)

check('没点之前没有浮层', render(OverlayHost, {}) === null)
wide.props.onClick()
await tick()
const overlay = render(OverlayHost, {})
const dialog = find(overlay, (el) => el.props && el.props.role === 'dialog')[0]
check('点了之后浮层出现', !!dialog, overlay && overlay.type)
const overlayText = textOf(overlay)
// 迷你 React 按组件函数记状态，浮层里的 PanelBody 与设置页那个共用一份 index（真 React 是两个实例），
// 所以断言只要求「有二维码 + 有某个入口地址」，不锁定具体第几个网卡。
check(
  '浮层里也有二维码与统计',
  byType(overlay, 'img').length === 1 && overlayText.includes('会话') && /http:\/\/\d+\.\d+\.\d+\.\d+:8791\//.test(overlayText),
  overlayText.slice(0, 80),
)
check('浮层点了就关（整层可点）', typeof overlay.props.onClick === 'function' && overlay.props.style.pointerEvents === 'auto')
check('浮层卡片自己吃掉点击（不误关）', !!dialog && typeof dialog.props.onClick === 'function')
check('浮层有 ESC 监听', listeners.has('keydown'))
listeners.get('keydown')({ key: 'Escape' })
check('ESC 关掉浮层', render(OverlayHost, {}) === null)

/* ── 坏数据不白屏 + 迟到响应不许盖掉新结果 ── */

let release = null
answer = () => new Promise((resolve) => {
  release = () => resolve(response(payload))
})
render(SettingsSection, {}) // 这一发请求挂住不返回，模拟慢网络
answer = async () => {
  throw new Error('boom')
}
await buttonWith(render(SettingsSection, {}), '刷新').props.onClick()
await tick()
const broken = render(SettingsSection, {})
check('接口挂了会说出原因', textOf(broken).includes('读不到面板数据：boom'), textOf(broken).slice(0, 60))
check('接口挂了仍显示上一次的二维码', byType(broken, 'img').length === 1)

// 回归：慢响应回来时必须作废，否则会盖掉更新的失败状态
release()
await tick()
await tick()
check('迟到的成功不会盖掉新结果', textOf(render(SettingsSection, {})).includes('读不到面板数据：boom'), textOf(render(SettingsSection, {})).slice(0, 60))

answer = async () => response({}, 500)
await buttonWith(render(SettingsSection, {}), '刷新').props.onClick()
await tick()
check('HTTP 错误也算失败', textOf(render(SettingsSection, {})).includes('HTTP 500'))

/* ── MD3 Expressive 样式表：注入一次、颜色走宿主 token ── */

const styles = appended.filter((node) => node.id === 'lan-tasks-md3')
check('注入了 MD3 样式表', styles.length === 1, `styles=${styles.length}`)
const css = styles.length ? String(styles[0].textContent) : ''
check('样式表只注入一次', styles.length === 1)
check(
  '颜色角色取自宿主主题 token',
  css.includes('--ltk-primary:var(--dsw-alias-brand-primary') &&
    css.includes('--ltk-on-surface:var(--dsw-alias-label-primary') &&
    css.includes('--ltk-outline-variant:var(--dsw-alias-border-l1'),
  '',
)
check('带 M3 形状阶与弹簧动效', css.includes('--ltk-r-2xl:28px') && css.includes('--ltk-spring:cubic-bezier(.34,1.56,.64,1)'))
check('带 reduced-motion 降级', css.includes('prefers-reduced-motion:reduce'))
check('面板用 class 而不是内联样式', byType(tree, 'section')[0].props.className.includes('ltk-card') && !byType(tree, 'section')[0].props.style)

/* ── 包清单：客户端插件必需的字段 ── */
check('版本号与包清单一致', payload.version === pkg.version, `${payload.version} vs ${pkg.version}`)
check(
  '清单声明了 web 客户端插件',
  pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web' && pkg.dsh.client.immediately === true,
  JSON.stringify(pkg.dsh && pkg.dsh.client),
)
check('清单 exports 暴露 client', pkg.exports['./client'] === './client.js')
check('files 收进了 client.js', pkg.files.includes('client.js'))
check('客户端插件声明依赖设置页插槽', (pkg.dsh.client.inject || []).includes('@deepseek-ai/dsh-client-ui-settings'))

console.log('\n' + results.filter((r) => !r.ok).length + ' 项失败 / 共 ' + results.length + ' 项')
process.exit(results.some((r) => !r.ok) ? 1 : 0)
