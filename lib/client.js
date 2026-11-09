/**
 * @dafeiyu/dsh-memory-brain — client 半边（浏览器模块）。
 *
 * 在「会话视图」的 tab 列表（conversation.view）里加一个「忆核大脑」页：
 * 用同源 iframe 铺满整个视图区，加载 host 半边的 `<prefix>/` 页面。
 * 渲染前先探一次 `<prefix>/api/health`：通了才亮出 iframe；不通就把 URL、
 * HTTP 状态/错误原因和「重试」按钮显示出来（桌面宿主可能叠了 token/代理层，
 * 直接把 401/503 暴露出来比白屏好排查）。
 */
window.__ModuleLoader__.load({
  id: '@dafeiyu/dsh-memory-brain',
  factory(require) {
    const React = require('react')

    /** host 半边的 webServer 前缀路由（改了 lib/index.js 的默认 prefix 要同步改这里）。 */
    const PANEL_PATH = '/memory-brain/'

    /**
     * 面板 URL：
     * 1) HTTP 宿主下优先同源绝对地址（iframe 天然带同一份凭证/cookie）；
     * 2) 把当前页面的 token 类 query 透传过去（桌面宿主可能用带 token 的 URL 打开 GUI）；
     * 3) 非 http(s) 协议（如自定义 scheme）退回相对路径，交给宿主解析。
     * @returns {string} 用作 iframe src 的地址
     */
    function panelUrl() {
      try {
        const loc = window.location
        const isHttp = /^https?:$/.test(loc.protocol)
        const base = isHttp ? loc.origin + PANEL_PATH : PANEL_PATH
        if (!isHttp) return base
        const u = new URL(base)
        const q = new URLSearchParams(loc.search)
        for (const k of ['token', 'access_token', 'auth', 't', 'key']) {
          if (q.has(k)) u.searchParams.set(k, q.get(k))
        }
        return u.toString()
      } catch {
        return PANEL_PATH
      }
    }

    const PAGE_STYLE = {
      flex: '1 1 auto',
      minHeight: 0,
      position: 'relative',
      display: 'flex',
      background: '#01060e',
    }

    const CARD_STYLE = {
      maxWidth: 560,
      padding: '22px 24px',
      border: '1px solid rgba(120,180,220,.25)',
      borderRadius: 12,
      background: 'rgba(6,18,30,.92)',
      fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      color: '#cfe3f2',
    }

    /**
     * 忆核大脑面板：铺满会话视图区。
     * @returns {import('react').ReactElement}
     */
    function MemoryBrainView(props) {
      const url = React.useMemo(panelUrl, [])
      const frameRef = React.useRef(null)
      const [phase, setPhase] = React.useState('probe')
      const [detail, setDetail] = React.useState('')

      const probe = React.useCallback(() => {
        let alive = true
        setPhase('probe')
        setDetail('')
        fetch(url + 'api/health', { credentials: 'include', cache: 'no-store' })
          .then(async (r) => {
            if (!alive) return
            if (r.ok) {
              setPhase('ready')
              return
            }
            let msg = 'HTTP ' + r.status
            try {
              const body = await r.json()
              if (body && body.error) msg += ' · ' + body.error
            } catch {
              /* 非 JSON 响应，保留 HTTP 状态 */
            }
            setDetail(msg)
            setPhase('fail')
          })
          .catch((e) => {
            if (!alive) return
            setDetail(String(e && e.message ? e.message : e))
            setPhase('fail')
          })
        return () => {
          alive = false
        }
      }, [url])

      React.useEffect(() => probe(), [probe])

      /* iframe 里的页面点「退出登录」时，让宿主切回「对话」视图。 */
      React.useEffect(() => {
        function onMessage(e) {
          if (e.origin !== window.location.origin) return
          if (!e.data || e.data.type !== 'memory-brain:exit-to-chat') return
          const frame = frameRef.current
          if (frame && e.source && e.source !== frame.contentWindow) return
          if (props && typeof props.openView === 'function') {
            props.openView('chat', '')
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [props])

      if (phase === 'fail') {
        return React.createElement(
          'div',
          { style: { ...PAGE_STYLE, alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box' } },
          React.createElement(
            'div',
            { style: CARD_STYLE },
            React.createElement('div', { style: { fontSize: 16, marginBottom: 10 } }, '忆核大脑加载失败'),
            React.createElement('div', { style: { fontSize: 12, color: '#8ea4b8', marginBottom: 6, wordBreak: 'break-all' } }, url),
            React.createElement('div', { style: { fontSize: 12, color: '#ff9a9a', marginBottom: 12, wordBreak: 'break-word' } }, detail || '未知错误'),
            React.createElement(
              'div',
              { style: { fontSize: 12, color: '#8ea4b8', marginBottom: 16, lineHeight: 1.6 } },
              '请确认 host 半边已启动、数据包可读（<prefix>/api/health）。修好后点「重试」。',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: probe,
                style: {
                  padding: '6px 16px',
                  borderRadius: 8,
                  border: '1px solid rgba(84,231,255,.5)',
                  background: 'rgba(84,231,255,.12)',
                  color: '#9ff0ff',
                  cursor: 'pointer',
                },
              },
              '重试',
            ),
          ),
        )
      }

      return React.createElement(
        'div',
        { style: PAGE_STYLE },
        React.createElement('iframe', {
          ref: frameRef,
          src: url,
          title: '忆核大脑',
          allow: 'fullscreen',
          style: {
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            border: 0,
            background: '#01060e',
            opacity: phase === 'ready' ? 1 : 0,
            transition: 'opacity .25s ease',
          },
        }),
        phase === 'probe'
          ? React.createElement(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#01060e',
                  color: '#9ff0ff',
                  fontSize: 13,
                  fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
                },
              },
              '正在连接忆核大脑…',
            )
          : null,
      )
    }

    /** 需要 slots 服务；用 inject 声明，fiber 会等服务就绪。 */
    const inject = ['slots']

    /**
     * 往 conversation.view（会话视图 tab 列表）里加一个「忆核大脑」页。
     * conversation.view 由 ui-conversation 声明，故走 slots.inject 等待声明。
     * @param {unknown} ctx client root context
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'memory-brain',
            order: 10,
            label: () => '忆核大脑',
          },
          MemoryBrainView,
        ),
      )
    }

    return { apply, inject }
  },
})
