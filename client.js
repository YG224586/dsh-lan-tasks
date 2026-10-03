/**
 * dsh-lan-tasks · 桌面 GUI 半边（浏览器端客户端插件）
 *
 * 挂三个位置：
 *   1. settings.section        设置页里的完整面板（二维码 + 状态 + 统计）
 *   2. sidebar.footer.action   侧栏底部「设置」旁边的一颗按钮，点开浮层
 *   3. shell.overlay           浮层本体（宿主提供的整帧浮层，默认穿透点击）
 *
 * 数据从宿主的 /lan-tasks/state 拿（同源，Host 半边注册的路由），
 * 二维码直接 `<img src="/lan-tasks/qr.svg?i=N">`，编码在 Host 侧做，浏览器里不塞编码器。
 *
 * 样式：MD3 Expressive（Material Design 3 Expressive）——
 *   · 颜色仍取 DSH 主题 token（--dsw-alias-*），只是重新映射成 M3 角色
 *     （surface / surface-container / on-surface / primary / outline…），
 *     这样深浅色主题都跟着宿主走，不会在浅色主题里变成一块深色补丁；
 *   · 形状阶、tonal 表面层级、弹簧动效、字阶按 M3 Expressive 来做。
 *   样式表只注入一次（<style id="lan-tasks-md3">），组件本身只用 class。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lan-tasks',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/lan-tasks/state'
    const REFRESH_MS = 5000

    /* ────────────────────────── MD3 Expressive 样式表 ────────────────────────── */

    const STYLE_ID = 'lan-tasks-md3'
    const CSS = `
.ltk{
  /* M3 颜色角色 ← DSH 主题 token（token 缺失时用深色 M3 取值兜底） */
  --ltk-surface:var(--dsw-alias-bg-layer-1,#15191e);
  --ltk-sc-low:var(--dsw-alias-bg-base,#0f1216);
  --ltk-sc:var(--dsw-alias-bg-layer-2,#1a1e24);
  --ltk-sc-high:var(--dsw-alias-bg-layer-2,#242930);
  --ltk-on-surface:var(--dsw-alias-label-primary,#e3e2e6);
  --ltk-on-surface-variant:var(--dsw-alias-label-secondary,#c3c6cf);
  --ltk-outline:var(--dsw-alias-border-l2,#8d9199);
  --ltk-outline-variant:var(--dsw-alias-border-l1,#41454c);
  --ltk-primary:var(--dsw-alias-brand-primary,#b9c8ff);
  --ltk-primary-container:color-mix(in oklab,var(--dsw-alias-brand-primary,#b9c8ff) 22%,transparent);
  --ltk-ok:var(--dsw-alias-state-success-primary,#7cd98f);
  --ltk-warn:var(--dsw-alias-state-warn-primary,#ffcf8f);
  --ltk-err:var(--dsw-alias-state-error-primary,#ffb4ab);
  --ltk-idle:var(--dsw-alias-state-idle-primary,#8d9199);
  /* M3 形状阶 */
  --ltk-r-xs:4px; --ltk-r-sm:8px; --ltk-r-md:12px; --ltk-r-lg:16px; --ltk-r-xl:20px;
  --ltk-r-2xl:28px; --ltk-r-full:999px;
  /* M3 Expressive 动效 */
  --ltk-spring:cubic-bezier(.34,1.56,.64,1);
  --ltk-emph:cubic-bezier(.2,0,0,1);
  --ltk-fast:180ms; --ltk-mid:280ms;
}
.ltk,.ltk *{box-sizing:border-box}

/* 卡片 / 容器：用表面层级 + 大圆角做层次，不靠重投影 */
.ltk-card{display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:var(--ltk-r-2xl);
  background:var(--ltk-sc-low);border:1px solid var(--ltk-outline-variant);color:var(--ltk-on-surface);
  animation:ltkRise var(--ltk-mid) var(--ltk-emph) both}
.ltk-panel{display:flex;flex-direction:column;gap:14px}
.ltk-head{display:flex;align-items:center;gap:10px}
.ltk-head h3{margin:0;font:600 15px/1.3 inherit;letter-spacing:.1px}
.ltk-head .ltk-glyph{color:var(--ltk-primary);line-height:0}
.ltk-head .ltk-hint{margin-left:auto;font:400 12px/1.5 inherit;color:var(--ltk-on-surface-variant)}

/* 状态行 */
.ltk-status{display:flex;align-items:center;gap:9px;font:400 13px/1.5 inherit;color:var(--ltk-on-surface-variant)}
.ltk-dot{width:10px;height:10px;border-radius:var(--ltk-r-full);flex:0 0 auto;
  transition:background var(--ltk-fast) var(--ltk-emph),box-shadow var(--ltk-fast) var(--ltk-emph)}
.ltk-dot.ltk-live{animation:ltkPulse 2.6s var(--ltk-emph) infinite}

/* 二维码：白底是扫码的硬要求，深色主题下也保持白 */
.ltk-qrWrap{padding:12px;background:#fff;border-radius:var(--ltk-r-xl);
  border:1px solid var(--ltk-outline-variant);line-height:0;
  animation:ltkRise var(--ltk-mid) var(--ltk-emph) both}
.ltk-qr{display:block;image-rendering:pixelated}

.ltk-split{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}
.ltk-col{display:flex;flex-direction:column;gap:10px;min-width:220px;flex:1 1 220px}
.ltk-lead{font:400 13px/1.55 inherit;color:var(--ltk-on-surface)}
.ltk-url{display:block;padding:10px 12px;border-radius:var(--ltk-r-lg);background:var(--ltk-sc);
  border:1px solid var(--ltk-outline-variant);color:var(--ltk-on-surface);
  font:400 12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
  word-break:break-all;user-select:all}
.ltk-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* 按钮：M3 tonal 药丸，按下回弹 */
.ltk-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 16px;
  border:1px solid transparent;border-radius:var(--ltk-r-full);
  background:var(--ltk-sc);color:var(--ltk-on-surface);
  font:500 13px/1 inherit;cursor:pointer;text-decoration:none;
  transition:transform var(--ltk-fast) var(--ltk-spring),background var(--ltk-fast) var(--ltk-emph)}
.ltk-btn:hover{background:var(--ltk-sc-high)}
.ltk-btn:active{transform:scale(.96)}
.ltk-btn.ltk-on{background:var(--ltk-primary-container);color:var(--ltk-primary);border-color:var(--ltk-primary)}
.ltk-btn.ltk-sm{height:28px;padding:0 12px;font:500 12px/1 inherit}
.ltk-btn.ltk-icon{width:38px;height:38px;padding:0;justify-content:center;border-radius:var(--ltk-r-full)}
.ltk-note{font:400 12px/1.55 inherit;color:var(--ltk-on-surface-variant)}

/* 统计瓦片 */
.ltk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:10px;
  padding-top:14px;border-top:1px solid var(--ltk-outline-variant)}
.ltk-stat{display:flex;flex-direction:column;gap:3px;padding:11px 13px;border-radius:var(--ltk-r-xl);
  background:var(--ltk-sc);border:1px solid var(--ltk-outline-variant);
  animation:ltkRise var(--ltk-mid) var(--ltk-emph) both}
.ltk-stat b{font:600 20px/1.15 inherit;letter-spacing:-.3px;font-variant-numeric:tabular-nums}
.ltk-stat span{font:400 12px/1.3 inherit;color:var(--ltk-on-surface-variant)}

.ltk-notes{display:flex;flex-direction:column;gap:4px}
.ltk-foot{font:400 12px/1.6 inherit;color:var(--ltk-on-surface-variant)}

/* 侧栏底部按钮 */
.ltk-footerBtn{display:inline-flex;align-items:center;gap:8px;height:38px;border-radius:var(--ltk-r-full);
  border:1px solid transparent;background:transparent;color:var(--ltk-on-surface-variant);cursor:pointer;
  font:500 13px/1 inherit;transition:background var(--ltk-fast) var(--ltk-emph),
  color var(--ltk-fast) var(--ltk-emph),transform var(--ltk-fast) var(--ltk-spring)}
.ltk-footerBtn:hover{background:var(--ltk-sc);color:var(--ltk-on-surface)}
.ltk-footerBtn:active{transform:scale(.96)}
.ltk-footerBtn.ltk-wide{width:100%;justify-content:flex-start;padding:0 12px}
.ltk-footerBtn.ltk-narrow{width:38px;justify-content:center;padding:0}
.ltk-footerBtn.ltk-open{background:var(--ltk-primary-container);color:var(--ltk-primary);border-color:var(--ltk-primary)}

/* 浮层：整帧遮罩 + 圆角卡片 */
.ltk-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  padding:20px;background:color-mix(in oklab,#000 55%,transparent);
  backdrop-filter:blur(3px);animation:ltkFade var(--ltk-fast) var(--ltk-emph) both}
.ltk-dialog{width:min(560px,100%);max-height:86vh;overflow:auto;padding:20px;
  border-radius:var(--ltk-r-2xl);background:var(--ltk-surface);border:1px solid var(--ltk-outline-variant);
  box-shadow:0 24px 60px color-mix(in oklab,#000 45%,transparent);
  animation:ltkSheet var(--ltk-mid) var(--ltk-emph) both}

@keyframes ltkRise{from{opacity:0;transform:translateY(9px) scale(.99)}to{opacity:1;transform:none}}
@keyframes ltkFade{from{opacity:0}to{opacity:1}}
@keyframes ltkSheet{from{opacity:0;transform:translateY(18px) scale(.985)}to{opacity:1;transform:none}}
@keyframes ltkPulse{0%,100%{box-shadow:0 0 0 4px color-mix(in oklab,currentColor 26%,transparent)}
  50%{box-shadow:0 0 0 7px color-mix(in oklab,currentColor 8%,transparent)}}

@media (prefers-reduced-motion:reduce){.ltk,.ltk *{animation:none !important;transition:none !important}}
`

    let styleDone = false
    /** 样式只注入一次；document 不在或没 head 时安静跳过（离线测试里就是这样）。 */
    function ensureStyle() {
      if (styleDone) return
      styleDone = true
      try {
        if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return
        if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID)) return
        const host = document.head || document.body
        if (!host || typeof host.appendChild !== 'function') return
        const el = document.createElement('style')
        el.id = STYLE_ID
        el.textContent = CSS
        host.appendChild(el)
      } catch {
        /* 样式注入失败不该拖垮面板本身 */
      }
    }

    /* ────────────────────────── 共享开关 ────────────────────────── */

    /** 侧栏按钮和浮层是两棵组件树，用一个极小的订阅存储连起来。 */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        read: () => value,
        write: (next) => {
          value = typeof next === 'function' ? next(value) : next
          for (const listener of listeners) {
            try {
              listener()
            } catch {
              /* 单个订阅者出错不影响别人 */
            }
          }
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const openStore = createStore(false)

    function useStore(store) {
      const [value, setValue] = React.useState(store.read)
      React.useEffect(() => store.subscribe(() => setValue(store.read())), [store])
      return value
    }

    /* ────────────────────────── 数据 ────────────────────────── */

    function usePanelData() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' })
      // 每次请求领一个号：慢响应回来时若已经发过更新的请求，就丢掉这份结果，
      // 否则「先发的失败」会被「后到的成功」盖掉（或反过来）。
      const seq = React.useRef(0)
      const load = React.useCallback(async () => {
        seq.current += 1
        const ticket = seq.current
        try {
          const res = await fetch(API, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!res.ok) throw new Error(`宿主返回 HTTP ${res.status}`)
          const data = await res.json()
          if (ticket !== seq.current) return
          setState({ phase: 'ready', data, error: '' })
        } catch (error) {
          if (ticket !== seq.current) return
          setState((prev) => ({
            phase: 'error',
            data: prev.data,
            error: String((error && error.message) || error || '读取失败'),
          }))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void load()
        }
        tick()
        const timer = setInterval(tick, REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      return [state, load]
    }

    /* ────────────────────────── 小组件 ────────────────────────── */

    function QrGlyph(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { key: 'a', x: 3, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { key: 'b', x: 14, y: 3, width: 7, height: 7, rx: 1.5 }),
        h('rect', { key: 'c', x: 3, y: 14, width: 7, height: 7, rx: 1.5 }),
        h('path', { key: 'd', d: 'M14 14h3v3h-3zM20.5 14v2M20.5 18.5V21H18M14 20.5h2' }),
      )
    }

    function CopyButton(props) {
      const [done, setDone] = React.useState(false)
      const timer = React.useRef(0)
      React.useEffect(() => () => clearTimeout(timer.current), [])

      const copy = React.useCallback(async () => {
        const text = props.text
        let ok = false
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            ok = true
          }
        } catch {
          ok = false
        }
        if (!ok) {
          // 剪贴板 API 在非安全上下文里会被拒，退回老办法
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', 'readonly')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            ok = document.execCommand('copy')
            document.body.removeChild(area)
          } catch {
            ok = false
          }
        }
        setDone(ok)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setDone(false), 1600)
      }, [props.text])

      return h(
        'button',
        { type: 'button', onClick: copy, className: 'ltk-btn', title: '复制到剪贴板' },
        done ? '已复制' : '复制链接',
      )
    }

    function Stat(props) {
      return h(
        'div',
        { className: 'ltk-stat' },
        h('b', null, String(props.value)),
        h('span', null, props.label),
      )
    }

    function StatusLine(props) {
      const data = props.data
      let color = 'var(--ltk-idle)'
      let live = false
      if (props.error) color = 'var(--ltk-err)'
      else if (data && data.listening) {
        color = 'var(--ltk-ok)'
        live = true
      } else if (data) color = 'var(--ltk-warn)'

      let text
      if (props.error) text = `读不到面板数据：${props.error}`
      else if (!data) text = '正在读取…'
      else if (!data.listening) text = `Host 未监听端口 ${data.port}，看板暂时打不开`
      else text = `dsh-lan-tasks v${data.version} · 端口 ${data.port} · 手机同 Wi-Fi 可访问`

      return h(
        'div',
        { className: 'ltk-status' },
        h('span', {
          className: live ? 'ltk-dot ltk-live' : 'ltk-dot',
          style: { background: color, color },
        }),
        h('span', null, text),
      )
    }

    function Notes(props) {
      const notes = props.notes || []
      if (!notes.length) return null
      return h(
        'div',
        { className: 'ltk-notes' },
        notes.slice(0, 4).map((note, index) => h('div', { key: index, className: 'ltk-note' }, `· ${note}`)),
      )
    }

    /** 面板主体：设置页和浮层共用。 */
    function PanelBody(props) {
      const state = props.state
      const data = state.data
      const [index, setIndex] = React.useState(0)
      React.useEffect(() => {
        if (data && data.addresses && index >= data.addresses.length) setIndex(0)
      }, [data, index])

      const addresses = (data && data.addresses) || []
      const current = addresses[index] || addresses[0]
      const stats = (data && data.stats) || {}
      const qrSize = props.compact ? 196 : 232

      return h(
        'div',
        { className: 'ltk-panel' },
        h(StatusLine, { data, error: state.error }),

        addresses.length
          ? h(
              'div',
              { className: 'ltk-split' },
              h(
                'div',
                { className: 'ltk-qrWrap' },
                h('img', {
                  className: 'ltk-qr',
                  src: current.qr,
                  width: qrSize,
                  height: qrSize,
                  alt: `打开 ${current.url} 的二维码`,
                  style: { display: 'block', width: qrSize, height: qrSize, imageRendering: 'pixelated' },
                }),
              ),
              h(
                'div',
                { className: 'ltk-col' },
                h('div', { className: 'ltk-lead' }, '手机相机对着二维码扫一下，就能打开这块看板。'),
                h('code', { className: 'ltk-url' }, current ? current.url : ''),
                h(
                  'div',
                  { className: 'ltk-row' },
                  h(CopyButton, { text: current ? current.url : '' }),
                  h(
                    'a',
                    {
                      className: 'ltk-btn',
                      href: current ? current.url : '#',
                      target: '_blank',
                      rel: 'noreferrer',
                    },
                    '在本机浏览器打开',
                  ),
                  h('button', { type: 'button', className: 'ltk-btn', onClick: () => void props.reload() }, '刷新'),
                ),
                addresses.length > 1
                  ? h(
                      'div',
                      { className: 'ltk-row' },
                      h('span', { className: 'ltk-note' }, '换一张：'),
                      addresses.map((item, i) =>
                        h(
                          'button',
                          {
                            key: item.address,
                            type: 'button',
                            onClick: () => setIndex(i),
                            title: item.url,
                            className: i === index ? 'ltk-btn ltk-sm ltk-on' : 'ltk-btn ltk-sm',
                          },
                          item.address,
                        ),
                      ),
                    )
                  : null,
                data && data.token === 'required'
                  ? h(
                      'div',
                      { className: 'ltk-note' },
                      '已开启访问口令：链接里带着 ?k=…，扫出来就能直接进，别把这张二维码发出局域网。',
                    )
                  : null,
              ),
            )
          : h(
              'div',
              { className: 'ltk-note' },
              '没找到局域网 IPv4 地址：确认这台机器连着 Wi-Fi 或有线网，然后重启 DSH。',
            ),

        h(
          'div',
          { className: 'ltk-stats' },
          h(Stat, { label: '会话', value: stats.agents == null ? '–' : stats.agents }),
          h(Stat, { label: '运行中', value: stats.running == null ? '–' : stats.running }),
          h(Stat, { label: '任务', value: stats.tasks == null ? '–' : stats.tasks }),
          h(Stat, { label: '进行中', value: stats.tasksActive == null ? '–' : stats.tasksActive }),
          h(Stat, { label: '已完成', value: stats.tasksDone == null ? '–' : stats.tasksDone }),
          h(Stat, { label: '作业', value: stats.jobs == null ? '–' : stats.jobs }),
        ),

        h(Notes, { notes: data && data.notes }),

        data
          ? h(
              'div',
              { className: 'ltk-foot' },
              `本机入口 ${data.localUrl} · 只读投影，不会改任何会话状态`,
            )
          : null,
      )
    }

    /* ────────────────────────── 三个挂载点 ────────────────────────── */

    function SettingsSection() {
      ensureStyle()
      const [state, reload] = usePanelData()
      return h(
        'section',
        { className: 'ltk ltk-card' },
        h(
          'header',
          { className: 'ltk-head' },
          h('span', { className: 'ltk-glyph' }, h(QrGlyph, { size: 20 })),
          h('h3', null, '局域网任务看板'),
          h('span', { className: 'ltk-hint' }, '手机扫码查看当前任务'),
        ),
        h(PanelBody, { state, reload }),
      )
    }

    function FooterAction(props) {
      ensureStyle()
      const wide = !!(props && props.wide)
      const open = useStore(openStore)
      const cls = ['ltk', 'ltk-footerBtn', wide ? 'ltk-wide' : 'ltk-narrow', open ? 'ltk-open' : ''].join(' ')
      return h(
        'button',
        {
          type: 'button',
          className: cls,
          title: '局域网任务看板 · 扫码用手机看',
          'aria-expanded': open,
          onClick: () => openStore.write(!openStore.read()),
        },
        h(QrGlyph, { size: 18 }),
        wide ? h('span', null, '局域网看板') : null,
      )
    }

    function OverlayHost() {
      ensureStyle()
      const open = useStore(openStore)
      const [state, reload] = usePanelData()

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event && event.key === 'Escape') openStore.write(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const close = () => openStore.write(false)
      return h(
        'div',
        { className: 'ltk ltk-overlay', onClick: close, style: { pointerEvents: 'auto' } },
        h(
          'div',
          {
            className: 'ltk-dialog',
            onClick: (event) => event.stopPropagation(),
            role: 'dialog',
            'aria-label': '局域网任务看板',
          },
          h(
            'header',
            { className: 'ltk-head', style: { marginBottom: 14 } },
            h('span', { className: 'ltk-glyph' }, h(QrGlyph, { size: 20 })),
            h('h3', null, '局域网任务看板'),
            h(
              'button',
              {
                type: 'button',
                className: 'ltk-btn ltk-sm',
                onClick: close,
                title: '关闭（Esc）',
                style: { marginLeft: 'auto' },
              },
              '关闭',
            ),
          ),
          h(PanelBody, { state, reload, compact: true }),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle()
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'lan-tasks', order: 32, label: '局域网任务看板' },
            SettingsSection,
          ),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'lan-tasks', order: 40, label: '局域网看板' },
            FooterAction,
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'lan-tasks', order: 60 }, OverlayHost),
        )
      },
    }
  },
})
