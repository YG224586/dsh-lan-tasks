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
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lan-tasks',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/lan-tasks/state'
    const REFRESH_MS = 5000

    /** 只用主题 token，深浅色主题都跟着走。 */
    const T = {
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      bgBase: 'var(--dsw-alias-bg-base)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      text1: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
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

    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 30,
      padding: '0 12px',
      borderRadius: 8,
      border: `1px solid ${T.border2}`,
      background: T.layer2,
      color: T.text1,
      font: '13px/1 inherit',
      cursor: 'pointer',
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

      return h('button', { type: 'button', onClick: copy, style: buttonStyle, title: '复制到剪贴板' }, done ? '已复制' : '复制链接')
    }

    function Stat(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 64 } },
        h('span', { style: { font: '600 17px/1.2 inherit', color: T.text1 } }, String(props.value)),
        h('span', { style: { font: '12px/1.2 inherit', color: T.text2 } }, props.label),
      )
    }

    function StatusLine(props) {
      const data = props.data
      const dot = { width: 8, height: 8, borderRadius: 4, background: T.idle, flex: '0 0 auto' }
      if (props.error) {
        dot.background = T.err
      } else if (data && data.listening) {
        dot.background = T.ok
      } else if (data) {
        dot.background = T.warn
      } else {
        dot.background = T.idle
      }
      let text
      if (props.error) text = `读不到面板数据：${props.error}`
      else if (!data) text = '正在读取…'
      else if (!data.listening) text = `Host 未监听端口 ${data.port}，看板暂时打不开`
      else text = `dsh-lan-tasks v${data.version} · 端口 ${data.port} · 手机同 Wi-Fi 可访问`
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, color: T.text2, font: '13px/1.5 inherit' } },
        h('span', { style: dot }),
        h('span', null, text),
      )
    }

    function Notes(props) {
      const notes = props.notes || []
      if (!notes.length) return null
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        notes.slice(0, 4).map((note, index) =>
          h('div', { key: index, style: { font: '12px/1.5 inherit', color: T.text2 } }, `· ${note}`),
        ),
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
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(StatusLine, { data, error: state.error }),

        addresses.length
          ? h(
              'div',
              { style: { display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' } },
              h(
                'div',
                {
                  style: {
                    padding: 10,
                    background: '#ffffff',
                    borderRadius: 10,
                    border: `1px solid ${T.border1}`,
                    lineHeight: 0,
                  },
                },
                h('img', {
                  src: current.qr,
                  width: qrSize,
                  height: qrSize,
                  alt: `打开 ${current.url} 的二维码`,
                  style: { display: 'block', width: qrSize, height: qrSize, imageRendering: 'pixelated' },
                }),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 220, flex: '1 1 220px' } },
                h(
                  'div',
                  { style: { font: '13px/1.5 inherit', color: T.text1 } },
                  '手机相机对着二维码扫一下，就能打开这块看板。',
                ),
                h(
                  'code',
                  {
                    style: {
                      display: 'block',
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: T.bgBase,
                      border: `1px solid ${T.border1}`,
                      color: T.text1,
                      font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
                      wordBreak: 'break-all',
                      userSelect: 'all',
                    },
                  },
                  current ? current.url : '',
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h(CopyButton, { text: current ? current.url : '' }),
                  h(
                    'a',
                    {
                      href: current ? current.url : '#',
                      target: '_blank',
                      rel: 'noreferrer',
                      style: Object.assign({}, buttonStyle, { textDecoration: 'none' }),
                    },
                    '在本机浏览器打开',
                  ),
                  h('button', { type: 'button', onClick: () => void props.reload(), style: buttonStyle }, '刷新'),
                ),
                addresses.length > 1
                  ? h(
                      'div',
                      { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
                      h('span', { style: { font: '12px/1.5 inherit', color: T.text2 } }, '换一张：'),
                      addresses.map((item, i) =>
                        h(
                          'button',
                          {
                            key: item.address,
                            type: 'button',
                            onClick: () => setIndex(i),
                            title: item.url,
                            style: Object.assign({}, buttonStyle, {
                              height: 26,
                              padding: '0 10px',
                              font: '12px/1 inherit',
                              borderColor: i === index ? T.brand : T.border2,
                              color: i === index ? T.brand : T.text2,
                            }),
                          },
                          item.address,
                        ),
                      ),
                    )
                  : null,
                data && data.token === 'required'
                  ? h(
                      'div',
                      { style: { font: '12px/1.5 inherit', color: T.text2 } },
                      '已开启访问口令：链接里带着 ?k=…，扫出来就能直接进，别把这张二维码发出局域网。',
                    )
                  : null,
              ),
            )
          : h(
              'div',
              { style: { font: '13px/1.6 inherit', color: T.text2 } },
              '没找到局域网 IPv4 地址：确认这台机器连着 Wi-Fi 或有线网，然后重启 DSH。',
            ),

        h(
          'div',
          { style: { display: 'flex', gap: 22, flexWrap: 'wrap', paddingTop: 12, borderTop: `1px solid ${T.border1}` } },
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
              { style: { font: '12px/1.6 inherit', color: T.text2 } },
              `本机入口 ${data.localUrl} · 只读投影，不会改任何会话状态`,
            )
          : null,
      )
    }

    /* ────────────────────────── 三个挂载点 ────────────────────────── */

    function SettingsSection() {
      const [state, reload] = usePanelData()
      return h(
        'section',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            padding: 18,
            borderRadius: 14,
            background: T.layer1,
            border: `1px solid ${T.border1}`,
          },
        },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', { style: { color: T.brand, lineHeight: 0 } }, h(QrGlyph, { size: 20 })),
          h('h3', { style: { margin: 0, font: '600 15px/1.3 inherit', color: T.text1 } }, '局域网任务看板'),
          h(
            'span',
            { style: { marginLeft: 'auto', font: '12px/1.5 inherit', color: T.text2 } },
            '手机扫码查看当前任务',
          ),
        ),
        h(PanelBody, { state, reload }),
      )
    }

    function FooterAction(props) {
      const wide = !!(props && props.wide)
      const open = useStore(openStore)
      return h(
        'button',
        {
          type: 'button',
          title: '局域网任务看板 · 扫码用手机看',
          'aria-expanded': open,
          onClick: () => openStore.write(!openStore.read()),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: wide ? 'flex-start' : 'center',
            gap: 8,
            width: wide ? '100%' : 36,
            height: 36,
            padding: wide ? '0 10px' : 0,
            borderRadius: 9,
            border: `1px solid ${open ? T.brand : 'transparent'}`,
            background: open ? T.layer2 : 'transparent',
            color: open ? T.brand : T.text2,
            font: '13px/1 inherit',
            cursor: 'pointer',
          },
        },
        h(QrGlyph, { size: 18 }),
        wide ? h('span', null, '局域网看板') : null,
      )
    }

    function OverlayHost() {
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
        {
          onClick: close,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            background: 'rgba(0, 0, 0, 0.45)',
            pointerEvents: 'auto',
          },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            role: 'dialog',
            'aria-label': '局域网任务看板',
            style: {
              width: 'min(560px, 100%)',
              maxHeight: '86vh',
              overflow: 'auto',
              padding: 20,
              borderRadius: 16,
              background: T.layer1,
              border: `1px solid ${T.border1}`,
              boxShadow: '0 24px 60px rgba(0, 0, 0, 0.45)',
              color: T.text1,
            },
          },
          h(
            'header',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
            h('span', { style: { color: T.brand, lineHeight: 0 } }, h(QrGlyph, { size: 20 })),
            h('h3', { style: { margin: 0, font: '600 15px/1.3 inherit' } }, '局域网任务看板'),
            h(
              'button',
              {
                type: 'button',
                onClick: close,
                title: '关闭（Esc）',
                style: Object.assign({}, buttonStyle, { marginLeft: 'auto', height: 28, padding: '0 10px' }),
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
