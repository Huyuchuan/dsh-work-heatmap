/**
 * dsh-work-heatmap — GitHub 风格「工作热力图」插件（浏览器端 bundle）
 *
 * 挂载点：会话首屏 Hero 的标题（DeepSeek 标志 + Slogan）之下、输入框之上。
 * 实现方式：注册 root 作用域的 shell.overlay 组件，再通过 portal 把卡片
 * 插入 Hero 的 stack 容器（DSH 未在 Hero 内开放插槽，这是不修改内核的
 * 唯一可行位置），Hero 消失（进入普通对话）时自动卸载。
 *
 * 交互：卡片本身只留「图形 + 口径切换 + 图例」，不写标题；每次挂载到首屏
 * 时向宿主请求一次强制刷新。
 *
 * 数据源：GET /api/dsh-work-heatmap/summary（宿主半侧按天聚合本地会话日志）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-work-heatmap',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const WEEKS = 56
    const MONTH_ROW = 12 // 月份标签行高，与左侧星期列对齐用

    const CSS = `
.hm-host{display:block;position:relative;height:0;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));margin:0 auto;min-width:0}
.hm-card{box-sizing:border-box;position:absolute;top:12px;left:0;right:0;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:8px 10px 6px;box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary);animation:hm-in .18s ease-out}
@keyframes hm-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.hm-chart{display:grid;grid-template-columns:9px minmax(0,1fr);column-gap:6px;align-items:stretch}
.hm-wd{display:grid;grid-template-rows:repeat(7,1fr);row-gap:2px;padding-top:${MONTH_ROW}px}
.hm-wd span{display:flex;align-items:center;justify-content:flex-start;font-size:9px;line-height:1;color:var(--dsw-alias-label-caption)}
.hm-right{min-width:0}
.hm-months{position:relative;height:${MONTH_ROW}px}
.hm-months span{position:absolute;top:0;font-size:9px;line-height:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.hm-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);grid-auto-columns:1fr;gap:2px;width:100%}
.hm-cell{border-radius:2.5px;background:var(--dsw-alias-bg-module-platform);box-shadow:inset 0 0 0 1px rgba(127,127,127,.10);transition:transform .08s ease,box-shadow .08s ease}
.hm-cell:hover{transform:scale(1.12);box-shadow:0 0 0 1px var(--dsw-alias-label-tertiary)}
.hm-cell[data-empty="1"]{background:transparent;box-shadow:none}
.hm-cell[data-lv="1"]{background:rgba(77,107,254,.20)}
.hm-cell[data-lv="2"]{background:rgba(77,107,254,.40)}
.hm-cell[data-lv="3"]{background:rgba(77,107,254,.64)}
.hm-cell[data-lv="4"]{background:rgba(77,107,254,.90)}
.hm-foot{display:flex;align-items:center;justify-content:space-between;margin-top:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}
.hm-modes{display:inline-flex;align-items:center;gap:10px}
.hm-mode{border:0;background:none;padding:0;margin:0;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;cursor:pointer;transition:color .12s}
.hm-mode:hover{color:var(--dsw-alias-label-secondary)}
.hm-mode[data-on="1"]{color:var(--dsw-alias-label-primary);font-weight:500}
.hm-total{margin-left:auto;margin-right:12px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}
.hm-legend{display:inline-flex;align-items:center;gap:2px;white-space:nowrap;flex:none}
.hm-legend span{font-size:10px;line-height:12px}
.hm-legend .hm-cell{width:7px;height:7px;border-radius:1.5px;flex:none}
.hm-legend .hm-cell:hover{transform:none;box-shadow:none}
.hm-pending{padding:18px 0 22px;text-align:center;font-size:11px;color:var(--dsw-alias-label-caption)}
@media (prefers-reduced-motion: reduce){.hm-card{animation:none}.hm-cell{transition:none}}
`

    // ---------------------------------------------------------------- utils
    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    /** 千分位 */
    function fmtNum(n) {
      return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** token 数量级较大，用 k/M 压缩显示 */
    function fmtCompact(n) {
      const v = Number(n) || 0
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k'
      return String(v)
    }

    function fmtDate(d) {
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    }

    /** 找到 Hero 的 stack 容器：标题（含品牌标志）的父节点 */
    function findHeroStack() {
      let best = null
      let bestWidth = 0
      const candidates = document.querySelectorAll('[class*="_headline"]')
      for (let i = 0; i < candidates.length; i += 1) {
        const el = candidates[i]
        const parent = el.parentElement
        if (parent === null || String(parent.className || '').indexOf('_stack') === -1) continue
        const rect = el.getBoundingClientRect()
        if (rect.width < 200 || rect.height < 10) continue
        // 首屏标题必然带品牌标志（动画鱼 / 官方 logo）；没有 svg 的标题视为其他 UI
        if (el.querySelector('svg') === null) continue
        if (rect.width > bestWidth) {
          bestWidth = rect.width
          best = parent
        }
      }
      if (best !== null) return best
      // 兜底：品牌标志被替换成非 svg 时，仍按「最宽的标题 + _stack 父节点」定位
      for (let i = 0; i < candidates.length; i += 1) {
        const el = candidates[i]
        const parent = el.parentElement
        if (parent === null || String(parent.className || '').indexOf('_stack') === -1) continue
        const rect = el.getBoundingClientRect()
        if (rect.width < 200 || rect.height < 10) continue
        if (rect.width > bestWidth) {
          bestWidth = rect.width
          best = parent
        }
      }
      return best
    }

    /**
     * 找到「输入框之后」的挂载容器。
     * Hero 的 DOM 层级是 stack → HeroShell.root → composerStack → [data-composer-seat]，
     * 输入框是 composerStack 的最后一个兄弟；把节点追加进 [data-composer-seat] 的直接子节点
     * 即落在输入框下方。找不到时退回标题容器（老行为：标题下方）。
     */
    function findComposerHost(stack) {
      const seat = document.querySelector('[data-composer-seat]')
      if (seat !== null) {
        const input = seat.querySelector('[contenteditable], textarea')
        if (input !== null) {
          // 从输入框上溯，找到「同时包含标题与输入框」的最低容器（即 composerStack）
          let node = input
          for (let i = 0; i < 10 && node.parentElement !== null; i += 1) {
            if (node.parentElement.contains(stack)) return node.parentElement
            node = node.parentElement
          }
        }
      }
      return stack
    }

    function quantile(sorted, q) {
      if (sorted.length === 0) return 0
      const pos = (sorted.length - 1) * q
      const base = Math.floor(pos)
      const rest = pos - base
      if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base])
      return sorted[base]
    }

    // ------------------------------------------------------------- heatmap
    function HeatCard(props) {
      const data = props.data
      const mode = props.mode
      const onMode = props.onMode

      const view = React.useMemo(() => {
        const rows = Array.isArray(data.days) ? data.days : []
        const byDate = new Map()
        for (const row of rows) byDate.set(row[0], row)

        const idx = mode === 'calls' ? 2 : mode === 'prompts' ? 3 : mode === 'tokens' ? 5 : 1
        const today = new Date()
        const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
        // 固定 26 周窗口（与 GitHub 贡献图一致）：数据不足时左侧保留空白周
        const start = new Date(startOfToday)
        start.setDate(start.getDate() - 7 * (WEEKS - 1))
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7))

        const cols = []
        const cells = []
        const values = []
        const cursor = new Date(start)
        while (cursor <= startOfToday) {
          const week = []
          for (let d = 0; d < 7; d += 1) {
            const key = fmtDate(cursor)
            const future = cursor > startOfToday
            const row = byDate.get(key)
            const value = future ? 0 : row ? row[idx] : 0
            if (!future) values.push(value)
            week.push({ key, value, future, row })
            cursor.setDate(cursor.getDate() + 1)
          }
          cols.push(week)
        }

        const nonZero = values.filter((v) => v > 0).sort((a, b) => a - b)
        const t1 = Math.max(1, quantile(nonZero, 0.35))
        const t2 = Math.max(t1 + 1, quantile(nonZero, 0.62))
        const t3 = Math.max(t2 + 1, quantile(nonZero, 0.85))

        const level = (v) => {
          if (v <= 0) return 0
          if (v <= t1) return 1
          if (v <= t2) return 2
          if (v <= t3) return 3
          return 4
        }

        const months = []
        let lastMonth = -1
        for (let c = 0; c < cols.length; c += 1) {
          const month = Number(cols[c][0].key.slice(5, 7))
          if (month !== lastMonth) {
            const gapOk = months.length === 0 || c - months[months.length - 1].col >= 3
            if (gapOk) months.push({ col: c, month })
            lastMonth = month
          }
        }

        for (const col of cols) for (const cell of col) cells.push(cell)

        return { cells, level, months, active: nonZero.length }
      }, [data, mode])

      const totals = data.totals || {}
      const totalValue =
        mode === 'calls' ? totals.calls || 0 : mode === 'prompts' ? totals.prompts || 0 : mode === 'tokens' ? totals.tokens || 0 : totals.steps || 0
      const totalText =
        mode === 'tokens'
          ? fmtCompact(totalValue) + ' tokens'
          : mode === 'calls'
            ? fmtNum(totalValue) + ' 次调用'
            : mode === 'prompts'
              ? fmtNum(totalValue) + ' 次提示'
              : fmtNum(totalValue) + ' 步'

      const cellsNodes = []
      for (let i = 0; i < view.cells.length; i += 1) {
        const cell = view.cells[i]
        if (cell.future) {
          cellsNodes.push(h('div', { key: cell.key, className: 'hm-cell', 'data-empty': '1' }))
          continue
        }
        const tip = cell.row
          ? cell.key +
            ' · ' +
            cell.row[1] +
            ' 步 · ' +
            cell.row[2] +
            ' 次工具调用 · ' +
            cell.row[3] +
            ' 次提示 · ' +
            fmtCompact(cell.row[5]) +
            ' tokens'
          : cell.key + ' · 无记录'
        cellsNodes.push(
          h('div', {
            key: cell.key,
            className: 'hm-cell',
            'data-lv': String(view.level(cell.value)),
            title: tip,
          }),
        )
      }

      const monthNodes = view.months.map((m) =>
        h('span', { key: m.col, style: { left: (m.col / WEEKS) * 100 + '%' } }, m.month + '月'),
      )

      return h(
        'div',
        { className: 'hm-card' },
        view.active === 0
          ? h('div', { className: 'hm-pending' }, data.scanning ? '正在扫描本地会话日志…' : '暂无记录')
          : h(
              'div',
              { className: 'hm-chart' },
              h(
                'div',
                { className: 'hm-wd' },
                h('span', null, '一'),
                h('span', null, ''),
                h('span', null, '三'),
                h('span', null, ''),
                h('span', null, '五'),
                h('span', null, ''),
                h('span', null, ''),
              ),
              h(
                'div',
                { className: 'hm-right' },
                h('div', { className: 'hm-months' }, monthNodes),
                h(
                  'div',
                  {
                    className: 'hm-grid',
                    // 26 列 × 7 行等分可用宽度；行列比例 26:7 保证格子近似正方形
                    style: { aspectRatio: WEEKS + ' / 7' },
                  },
                  cellsNodes,
                ),
              ),
            ),
        h(
          'div',
          { className: 'hm-foot' },
          h(
            'div',
            { className: 'hm-modes' },
            ['tokens', 'steps', 'calls', 'prompts'].map((key) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'hm-mode',
                  'data-on': mode === key ? '1' : '0',
                  onClick: () => onMode(key),
                  title:
                    key === 'steps'
                      ? '每天完成的 Agent 步数'
                      : key === 'calls'
                        ? '每天的宿主工具调用次数'
                        : key === 'prompts'
                          ? '每天发出的提示与插话次数'
                          : '每天消耗的 token 数（含输入、输出与缓存读取）',
                },
                key === 'steps' ? '步数' : key === 'calls' ? '调用' : key === 'prompts' ? '提示' : 'Token',
              ),
            ),
          ),
          h('span', { className: 'hm-total' }, totalText),
          h(
            'div',
            { className: 'hm-legend' },
            h('span', null, '少'),
            ['0', '1', '2', '3', '4'].map((lv) =>
              h('div', { key: lv, className: 'hm-cell', 'data-lv': lv === '0' ? '0' : lv }),
            ),
            h('span', null, '多'),
          ),
        ),
      )
    }

    /** overlay 承载组件：把卡片 portal 进 Hero 的 stack 容器 */
    function HeroHeatmap() {
      const [host, setHost] = React.useState(null)
      const [data, setData] = React.useState(null)
      const [mode, setMode] = React.useState('tokens')
      const timerRef = React.useRef(0)
      const loadRef = React.useRef(null)

      const load = React.useCallback((force) => {
        return fetch('/api/dsh-work-heatmap/summary' + (force ? '?refresh=1' : ''), {
          headers: { 'cache-control': 'no-cache' },
        })
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then((json) => {
            setData(json)
            window.clearTimeout(timerRef.current)
            if (json && json.scanning) {
              timerRef.current = window.setTimeout(() => load(false), 2000)
            }
          })
          .catch(() => {})
      }, [])

      loadRef.current = load

      React.useEffect(() => {
        const node = document.createElement('div')
        node.className = 'hm-host'
        node.setAttribute('data-dsh-work-heatmap', '')

        // 宿主节点高度为 0、卡片绝对定位：卡片不参与布局，输入框位置完全不受影响。
        // 唯一影响是「新增一个 flex 子项 = 多一个 gap」，用等量负 margin 抵消。
        let attached = false

        const sync = () => {
          const stack = findHeroStack()
          if (stack === null) {
            if (attached) {
              attached = false
              if (node.parentNode !== null) node.parentNode.removeChild(node)
              setHost(null)
            }
            return
          }
          const target = findComposerHost(stack)
          if (node.parentNode !== target) target.appendChild(node)
          const gap = parseFloat(window.getComputedStyle(target).rowGap)
          const offset = Number.isFinite(gap) ? -gap : 0
          if (node.style.marginTop !== offset + 'px') node.style.marginTop = offset + 'px'
          if (!attached) {
            attached = true
            setHost(node)
            // 每次回到首屏都重新取数（宿主侧对强制刷新有 60s 节流）
            if (loadRef.current) loadRef.current(true)
          }
        }

        sync()
        const observer = new MutationObserver(sync)
        observer.observe(document.body, { childList: true, subtree: true })
        const interval = window.setInterval(sync, 1500)

        return () => {
          observer.disconnect()
          window.clearInterval(interval)
          window.clearTimeout(timerRef.current)
          if (node.parentNode !== null) node.parentNode.removeChild(node)
        }
      }, [])

      if (host === null || data === null) return null
      return ReactDOM.createPortal(
        h(HeatCard, { data, mode, onMode: setMode }),
        host,
      )
    }

    const plugin = {
      name: 'dsh-work-heatmap',
      apply(ctx) {
        const debug = (window.__dshHeatmapDebug = { applied: true, registered: false, error: null })
        try {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-work-heatmap')
          style.textContent = CSS
          document.head.appendChild(style)
          ctx.effect(() => () => {
            if (style.parentNode !== null) style.parentNode.removeChild(style)
          })
        } catch (err) {
          debug.error = 'style: ' + String((err && err.message) || err)
        }

        // slots 服务由渲染器提供，激活顺序不保证：用 ctx.inject 等待它就绪
        const register = (scope) => {
          const slots = scope.get('slots')
          if (!slots) return
          slots.inject('shell.overlay', () => {
            return slots.register(
              { name: 'shell.overlay', id: 'dsh-work-heatmap.hero', order: 40, label: '工作热力图' },
              function HeatmapOverlay() {
                return h(HeroHeatmap, null)
              },
            )
          })
          debug.registered = true
        }
        if (typeof ctx.inject === 'function') {
          ctx.inject(['slots'], (scope) => register(scope))
        } else {
          register(ctx)
        }
      },
    }

    exports.default = plugin
    exports.apply = plugin.apply
    return module.exports
  },
})
