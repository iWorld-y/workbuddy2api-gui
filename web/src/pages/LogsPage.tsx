// LogsPage.tsx 请求日志：逐条列出网关处理过的请求（模型/账号/状态/首字/耗时/token/扣费）。
//
// 与「请求统计」页的分工：统计页看按模型的聚合趋势，本页看单次请求的账——
// 排障时「这一笔为什么慢/为什么失败/花了多少积分」在这里看。
// 数据源是网关 /v1/logs（按天落盘的明细，默认保留 30 天）。
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api'
import type { LogsResponse, RequestLog, SessionInfo } from '../types'
import { Alert, Empty, fmtNum, Spinner } from '../ui'

/** 时间范围快捷选项（窗口由前端算成 since/until 传给网关）。 */
const RANGES = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'all', label: '全部' },
]

const DAY_MS = 86_400_000

/** rangeWindow 把快捷范围折成 RFC3339 的 since/until（本地时区的自然日）。 */
function rangeWindow(v: string): { since?: string; until?: string } {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (v) {
    case 'today':
      return { since: startOfToday.toISOString() }
    case 'yesterday':
      return {
        since: new Date(startOfToday.getTime() - DAY_MS).toISOString(),
        // 减 1ms 让「昨天」是闭区间，避免把今天 00:00:00 整点算进来。
        until: new Date(startOfToday.getTime() - 1).toISOString(),
      }
    case '7d':
      return { since: new Date(now.getTime() - 7 * DAY_MS).toISOString() }
    case '30d':
      return { since: new Date(now.getTime() - 30 * DAY_MS).toISOString() }
    default:
      return {}
  }
}

/** 首字延迟：null（无首帧观测）显示 —。 */
function fmtMs(v: number | null): string {
  if (v == null) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`
}

/** 大数缩写（1.2M / 345.6K / 123）。 */
function fmtTok(v: number): string {
  if (!v) return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

/** 账号展示：昵称(uid8)，无昵称退回 uid8。 */
function acctLabel(r: RequestLog): string {
  return r.nick ? `${r.nick}(${r.uid8})` : r.uid8
}

function fmtTime(t: string): string {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return t
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function LogsPage({ session }: { session: SessionInfo }) {
  const [range, setRange] = useState('today')
  const [only, setOnly] = useState<'' | 'success' | 'failed'>('')
  const [model, setModel] = useState('')
  const [limit, setLimit] = useState(50)

  // 游标分页：before=0 表示第一页；history 存来访过的游标供「上一页」回退。
  const [before, setBefore] = useState(0)
  const [history, setHistory] = useState<number[]>([])

  const [data, setData] = useState<LogsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const w = rangeWindow(range)
        const r = await api.logs({
          limit,
          before: before || undefined,
          model: model.trim() || undefined,
          only: only || undefined,
          since: w.since,
          until: w.until,
        })
        setData(r)
        setError(null)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '加载请求日志失败')
      } finally {
        setLoading(false)
      }
    },
    [range, only, model, limit, before],
  )

  useEffect(() => {
    void load()
  }, [load])

  // 过滤条件变化时回到第一页，否则会拿着旧的游标翻到空页。
  useEffect(() => {
    setBefore(0)
    setHistory([])
  }, [range, only, model, limit])

  // 自动刷新只对第一页生效：翻页时刷新会把用户刚看的页顶掉。
  useEffect(() => {
    if (!autoRefresh || before !== 0) return
    const timer = window.setInterval(() => {
      void load(true)
    }, 10_000)
    return () => clearInterval(timer)
  }, [autoRefresh, before, load])

  const records = data?.records ?? []
  const noDetail = data != null && data.retention_days === 0

  const goPrev = () => {
    const prev = history.length > 0 ? history[history.length - 1] : 0
    setHistory(history.slice(0, -1))
    setBefore(prev)
  }
  const goNext = () => {
    if (!data?.next_before) return
    setHistory([...history, before])
    setBefore(data.next_before)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>请求日志</h1>
          <p>逐条请求的模型、账号、首字延迟、耗时、token 与扣费</p>
        </div>
        <div className="page-actions">
          <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            自动刷新
          </label>
          <button className="btn btn-sm" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>

      {error && <Alert kind="warn">{error}</Alert>}
      {noDetail && (
        <Alert kind="warn">
          网关未启用请求明细（metrics.log_retention_days 为负）。请开启后重启网关。
        </Alert>
      )}

      <div className="card">
        <div className="card-head">
          <h2>明细</h2>
          <span className="hint">
            {data ? `本页 ${data.count} 条 · 明细保留 ${data.retention_days} 天` : ''}
          </span>
        </div>

        <div className="row" style={{ marginBottom: 6 }}>
          <div className="field" style={{ flex: '0 0 150px', minWidth: 130 }}>
            <label>时间范围</label>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 130px', minWidth: 110 }}>
            <label>结果</label>
            <select value={only} onChange={(e) => setOnly(e.target.value as '' | 'success' | 'failed')}>
              <option value="">全部</option>
              <option value="success">成功</option>
              <option value="failed">失败</option>
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 220px', minWidth: 160 }}>
            <label>模型（精确匹配，留空=全部）</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="cn:deepseek-v4.1-flash" />
          </div>
          <div className="field" style={{ flex: '0 0 110px', minWidth: 90 }}>
            <label>每页</label>
            <select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </div>
        </div>

        {loading && !data ? (
          <Spinner label="正在加载请求日志…" />
        ) : records.length === 0 ? (
          <Empty>
            该条件下没有请求记录。
            <div style={{ marginTop: 6, fontSize: 12 }}>
              明细从网关本次升级后开始累积（Docker 下落在 ./data/logs，重建容器不清零）。
            </div>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>方式</th>
                  <th>账号</th>
                  <th className="num">状态</th>
                  <th className="num">首字</th>
                  <th className="num">耗时</th>
                  <th className="num">输入</th>
                  <th className="num">输出</th>
                  <th className="num">缓存命中</th>
                  <th className="num">扣费</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.seq}>
                    <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                      {fmtTime(r.time)}
                    </td>
                    <td>
                      <div className="mono" style={{ fontSize: 12.5 }}>
                        {r.model}
                      </div>
                    </td>
                    <td>{r.mode === 'stream' ? '流式' : '非流式'}</td>
                    <td style={{ fontSize: 12.5 }}>{acctLabel(r)}</td>
                    <td className="num">
                      <span className={r.status === 200 ? 'badge badge-ok' : 'badge badge-danger'}>{r.status}</span>
                    </td>
                    <td className="num">{fmtMs(r.ttfb_ms)}</td>
                    <td className="num" title={`${fmtNum(r.total_ms)} ms`}>
                      {fmtMs(r.total_ms)}
                    </td>
                    <td className="num" title={r.usage ? fmtNum(r.usage.prompt_tokens) : '未回 usage'}>
                      {r.usage ? fmtTok(r.usage.prompt_tokens) : '—'}
                    </td>
                    <td className="num" title={r.usage ? fmtNum(r.usage.completion_tokens) : '未回 usage'}>
                      {r.usage ? fmtTok(r.usage.completion_tokens) : '—'}
                    </td>
                    <td className="num" title={r.usage ? `命中 ${fmtNum(r.usage.cache_hit_tokens)} · 未命中 ${fmtNum(r.usage.cache_miss_tokens)}` : '未回 usage'}>
                      {r.usage ? fmtTok(r.usage.cache_hit_tokens) : '—'}
                    </td>
                    <td className="num">{r.credit == null ? '—' : r.credit.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="row" style={{ marginTop: 12, alignItems: 'center' }}>
          <span className="hint">
            第 {history.length + 1} 页
            {records.length > 0 && ` · 本页 ${records.length} 条`}
          </span>
          <div className="page-actions">
            <button className="btn btn-sm" disabled={history.length === 0 || loading} onClick={goPrev}>
              上一页
            </button>
            <button className="btn btn-sm" disabled={!data?.next_before || loading} onClick={goNext}>
              下一页
            </button>
          </div>
        </div>
      </div>

      {session.read_only && <div className="desc">当前为只读模式（本页仅查询，不受影响）。</div>}
    </>
  )
}
