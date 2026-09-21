// LogsPage.tsx 请求日志：逐条列出网关处理过的请求（模型/账号/状态/首字/耗时/token/吞吐/缓存率/扣费）。
//
// 与「请求统计」页的分工：统计页看按模型的聚合趋势，本页看单次请求的账——
// 排障时「这一笔为什么慢/为什么失败/花了多少积分」在这里看。
// 数据源是网关 /v1/logs（按天落盘的明细，默认保留 30 天）。
// 表头的 token/s 与缓存率逐行由既有字段推导，口径与统计页的吞吐/命中率一致（见各函数注释）；
// 表格上方的「本页汇总」只覆盖当前页已加载的记录，翻页即变。
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

/** 生成吞吐：输出 token ÷ 生成秒数，生成秒数 =（耗时 − 首字）。
 *  口径与「请求统计」页的吞吐一致；首字缺失（非流式）时退回总耗时，可用性优先于纯度。
 *  返回 null 表示无法计算（未回 usage / 无输出 / 耗时不足），调用方渲染为「—」。 */
function rowTokensPerSec(r: RequestLog): number | null {
  if (!r.usage || r.usage.completion_tokens <= 0) return null
  const genMs = r.total_ms - (r.ttfb_ms ?? 0)
  if (genMs <= 0) return null
  return r.usage.completion_tokens / (genMs / 1000)
}

/** 逐行缓存命中率：命中 ÷（命中 + 未命中）。
 *
 *  写入不计入分母 —— 它是「为后续命中预付的成本」，计进去会把首次请求的命中率压低，
 *  与网关聚合口径（internal/server/metrics.go 的 deriveModelStat）不一致。
 *  suspect 表示上游只回了命中数、没回未命中数：此时 miss=0 会让比率虚高到 100%，
 *  用「命中 + 未命中 是否等于输入」交叉校验识别，调用方需把它标出来而非照实展示。 */
function rowCacheRate(r: RequestLog): { rate: number; suspect: boolean } | null {
  if (!r.usage) return null
  const u = r.usage
  const denom = u.cache_hit_tokens + u.cache_miss_tokens
  if (denom <= 0) return null
  return {
    rate: u.cache_hit_tokens / denom,
    suspect: u.prompt_tokens > 0 && denom !== u.prompt_tokens,
  }
}

/** token/s 单元格的悬停说明：写清分母口径，以及显示「—」时到底缺了什么观测。 */
function tpsTitle(r: RequestLog, tps: number | null): string {
  const u = r.usage
  if (!u) return '未回 usage，无法计算吞吐'
  if (tps == null) {
    return u.completion_tokens <= 0 ? '无输出 token，无法计算吞吐' : '耗时不足以计算生成时间，无法计算吞吐'
  }
  if (r.ttfb_ms == null) {
    return `输出 ${fmtNum(u.completion_tokens)} ÷ 总耗时 ${fmtNum(r.total_ms)} ms：非流式无首字观测，该值含排队与预填充时间`
  }
  return `输出 ${fmtNum(u.completion_tokens)} ÷ 生成 ${fmtNum(r.total_ms - r.ttfb_ms)} ms`
}

/** 缓存率单元格的悬停说明：拆分完整时给明细，不完整时说明为什么带标记。 */
function cacheTitle(r: RequestLog, cache: { rate: number; suspect: boolean } | null): string {
  const u = r.usage
  if (!u) return '未回 usage'
  if (cache == null) return '上游未回缓存计数（命中与未命中均为 0）'
  const split = `命中 ${fmtNum(u.cache_hit_tokens)} · 未命中 ${fmtNum(u.cache_miss_tokens)}`
  if (cache.suspect) {
    return `${split}，与输入 ${fmtNum(u.prompt_tokens)} 不符：上游未回完整的未命中数，该比率偏高，不可直接采信`
  }
  return split
}

/** 汇总缓存率的悬停说明：加权口径、参与条数，以及带 * 时为什么不可直接采信。 */
function summaryCacheTitle(sum: PageSummary, rate: number | null): string {
  if (rate == null) return '本页没有可用的缓存计数（上游未回命中 / 未命中）'
  const base = `加权口径：命中 ${fmtNum(sum.cacheHit)} ÷（命中 + 未命中 ${fmtNum(sum.cacheHit + sum.cacheMiss)}）；参与 ${sum.cacheCount} / 本页 ${sum.total} 条`
  return sum.cacheSuspect
    ? `${base}。带 * ：本页有记录的上游缓存计数不完整，该值偏高`
    : base
}

/** 吞吐展示：一位小数（实测量级 2~450，无需缩写）。 */
function fmtTps(v: number): string {
  return v.toFixed(1)
}

/** 比率展示：一位小数百分比。 */
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

/** 缓存命中率配色：阈值与「请求统计」页一致，保证同一批数据两页读数一致。 */
function hitTone(rate: number): string {
  if (rate >= 0.5) return 'text-ok'
  if (rate >= 0.1) return 'text-warn'
  return 'text-dim'
}

/** 本页汇总的累加器。
 *
 *  各指标分母独立：某条记录缺哪项观测就不计入哪项，绝不把缺失当 0 ——
 *  否则「未回 usage 的请求」会把平均首字和缓存率往下拉（与网关聚合同口径）。 */
interface PageSummary {
  total: number
  success: number
  ttfbSum: number
  ttfbCount: number
  latSum: number
  promptTokens: number
  completionTokens: number
  usageCount: number
  cacheHit: number
  cacheMiss: number
  cacheCount: number
  cacheSuspect: boolean
  credit: number
  creditCount: number
}

/** pageSummary 汇总当前页这一批记录（范围仅限本页，翻页即变）。 */
function pageSummary(records: RequestLog[]): PageSummary {
  const s: PageSummary = {
    total: records.length,
    success: 0,
    ttfbSum: 0,
    ttfbCount: 0,
    latSum: 0,
    promptTokens: 0,
    completionTokens: 0,
    usageCount: 0,
    cacheHit: 0,
    cacheMiss: 0,
    cacheCount: 0,
    cacheSuspect: false,
    credit: 0,
    creditCount: 0,
  }
  for (const r of records) {
    if (r.status === 200) s.success++
    s.latSum += r.total_ms
    // 与网关 ttfbCount 同口径：只累加 > 0 的观测。
    if (r.ttfb_ms != null && r.ttfb_ms > 0) {
      s.ttfbSum += r.ttfb_ms
      s.ttfbCount++
    }
    if (r.usage) {
      s.usageCount++
      s.promptTokens += r.usage.prompt_tokens
      s.completionTokens += r.usage.completion_tokens
      const denom = r.usage.cache_hit_tokens + r.usage.cache_miss_tokens
      if (denom > 0) {
        s.cacheHit += r.usage.cache_hit_tokens
        s.cacheMiss += r.usage.cache_miss_tokens
        s.cacheCount++
        if (r.usage.prompt_tokens > 0 && denom !== r.usage.prompt_tokens) s.cacheSuspect = true
      }
    }
    if (r.credit != null) {
      s.credit += r.credit
      s.creditCount++
    }
  }
  return s
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

  // 本页汇总：只覆盖当前页已加载的记录，翻页即变 —— 所以文案必须标明「本页」。
  const sum = pageSummary(records)
  const successRate = sum.total > 0 ? sum.success / sum.total : null
  const cacheDenom = sum.cacheHit + sum.cacheMiss
  // 加权口径（Σ命中 ÷ Σ(命中+未命中)），与「请求统计」页一致；不用各行比率的算术平均，
  // 否则长短请求等权会让短请求的比例过度影响结果。
  const cacheRate = cacheDenom > 0 ? sum.cacheHit / cacheDenom : null

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
          <p>逐条请求的模型、账号、首字延迟、耗时、token、吞吐、缓存率与扣费</p>
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

        {/* 本页汇总：范围仅限当前页已加载的记录，翻页即变，故文案标明「本页」。
            各指标分母独立 —— 缺哪项观测就不计入哪项，绝不把缺失当 0。 */}
        {records.length > 0 && (
          <div className="summary-bar">
            <span className="summary-title">本页汇总 · {fmtNum(sum.total)} 条请求</span>
            <span className="summary-item" title={`成功 ${fmtNum(sum.success)} / 本页 ${fmtNum(sum.total)} 条（仅 HTTP 200 计入成功）`}>
              <span className="summary-label">成功率</span>
              <span className="summary-value">{successRate == null ? '—' : fmtPct(successRate)}</span>
            </span>
            <span className="summary-item" title={`有首字观测 ${sum.ttfbCount} / 本页 ${sum.total} 条：非流式无首字观测，不计入均值分母`}>
              <span className="summary-label">平均首字</span>
              <span className="summary-value">{sum.ttfbCount > 0 ? fmtMs(sum.ttfbSum / sum.ttfbCount) : '—'}</span>
            </span>
            <span className="summary-item" title={`对全部 ${sum.total} 条的总耗时求均值`}>
              <span className="summary-label">平均耗时</span>
              <span className="summary-value">{sum.total > 0 ? fmtMs(sum.latSum / sum.total) : '—'}</span>
            </span>
            <span className="summary-item" title={`有 usage 的 ${sum.usageCount} / ${sum.total} 条参与合计`}>
              <span className="summary-label">总输入</span>
              <span className="summary-value">{sum.usageCount > 0 ? fmtTok(sum.promptTokens) : '—'}</span>
            </span>
            <span className="summary-item" title={`有 usage 的 ${sum.usageCount} / ${sum.total} 条参与合计`}>
              <span className="summary-label">总输出</span>
              <span className="summary-value">{sum.usageCount > 0 ? fmtTok(sum.completionTokens) : '—'}</span>
            </span>
            <span className="summary-item" title={summaryCacheTitle(sum, cacheRate)}>
              <span className="summary-label">平均缓存率</span>
              <span className={`summary-value ${cacheRate == null ? '' : sum.cacheSuspect ? 'text-warn' : hitTone(cacheRate)}`}>
                {cacheRate == null ? '—' : `${fmtPct(cacheRate)}${sum.cacheSuspect ? '*' : ''}`}
              </span>
            </span>
            <span className="summary-item" title={`有扣费观测的 ${sum.creditCount} / ${sum.total} 条参与合计（单位：账号积分）`}>
              <span className="summary-label">总扣费</span>
              <span className="summary-value">{sum.creditCount > 0 ? sum.credit.toFixed(4) : '—'}</span>
            </span>
          </div>
        )}

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
                  <th className="num" title="输出 token ÷ 生成秒数（耗时减首字）；非流式无首字观测，以总耗时为分母">
                    token/s
                  </th>
                  <th className="num">缓存命中</th>
                  <th className="num" title="命中 ÷（命中 + 未命中）；缓存写入不计入分母">
                    缓存率
                  </th>
                  <th className="num">扣费</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const tps = rowTokensPerSec(r)
                  const cache = rowCacheRate(r)
                  return (
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
                      <td className="num" title={tpsTitle(r, tps)}>
                        {tps == null ? '—' : fmtTps(tps)}
                      </td>
                      <td className="num" title={r.usage ? `命中 ${fmtNum(r.usage.cache_hit_tokens)} · 未命中 ${fmtNum(r.usage.cache_miss_tokens)}` : '未回 usage'}>
                        {r.usage ? fmtTok(r.usage.cache_hit_tokens) : '—'}
                      </td>
                      <td className={`num ${cache == null ? '' : cache.suspect ? 'text-warn' : hitTone(cache.rate)}`} title={cacheTitle(r, cache)}>
                        {cache == null ? '—' : `${fmtPct(cache.rate)}${cache.suspect ? '*' : ''}`}
                      </td>
                      <td className="num">{r.credit == null ? '—' : r.credit.toFixed(4)}</td>
                    </tr>
                  )
                })}
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
