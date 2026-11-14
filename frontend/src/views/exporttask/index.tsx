import { useCallback, useEffect, useMemo, useState } from 'react'

import { postAction, request } from '@/api/client'
import BatchCreateModal from './BatchCreateModal'
import {
  ACTIONS_BY_STATUS,
  type BatchItemResult,
  type ExportRow,
  ENDPOINT,
  columns,
  STATUSES,
  type TaskStatus,
} from './model'
import TaskDetailDrawer from './TaskDetailDrawer'

type BatchActionOutcome = {
  entry_id: number
  action: string
  ok: boolean
  message: string
  任务编号?: string
}

type Filters = { keyword: string; status: string }

export default function ExporttaskView() {
  const [rows, setRows] = useState<ExportRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Filters>({ keyword: '', status: '' })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busyId, setBusyId] = useState<number | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [showBatchCreate, setShowBatchCreate] = useState(false)
  const [batchOutcomes, setBatchOutcomes] = useState<BatchActionOutcome[]>([])
  const [cancelTarget, setCancelTarget] = useState<ExportRow | null>(null)
  const [cancelReason, setCancelReason] = useState('')

  const reload = useCallback(async () => {
    setErrorMessage('')
    const params = new URLSearchParams()
    if (filters.keyword.trim()) params.set('keyword', filters.keyword.trim())
    if (filters.status) params.set('status', filters.status)
    try {
      const resp = await request(`${ENDPOINT}?${params.toString()}`)
      if (!resp.ok) throw new Error('分发任务列表读取失败')
      const payload = await resp.json()
      const items = (payload.items ?? []) as ExportRow[]
      setRows(items)
      setTotal(payload.total ?? 0)
      // 清掉已经不在当前页/已被过滤的勾选项，避免对不可见任务做批量动作。
      setSelected((prev) => new Set(items.map((r) => r.id).filter((id) => prev.has(id))))
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '数据分发列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  const stats = useMemo(() => {
    const running = rows.filter((r) => r.status === '执行中').length
    const done = rows.filter((r) => r.status === '已完成').length
    const approving = rows.filter((r) => r.status === '任务审批中').length
    return [
      { label: '当前页任务数', value: rows.length },
      { label: '待审批任务', value: approving },
      { label: '执行中任务', value: running },
      { label: '已完成任务', value: done },
    ]
  }, [rows])

  const selectableRows = rows.filter((r) => ACTIONS_BY_STATUS[r.status].length > 0)

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      const allSelected = selectableRows.length > 0 && selectableRows.every((r) => prev.has(r.id))
      return allSelected ? new Set() : new Set(selectableRows.map((r) => r.id))
    })
  }

  async function runSingleAction(row: ExportRow, action: string, reason?: string) {
    setBusyId(row.id)
    setErrorMessage('')
    setNotice('')
    try {
      const result = await postAction(`${ENDPOINT}/${row.id}/actions`, {
        values: { action },
        remark: reason ?? null,
      })
      if (!result.ok) {
        // 业务被拦截（跳级/离线/终态）：把后端原因展示出来，而不是“点不动”。
        setErrorMessage(result.message)
        return
      }
      setNotice(result.message)
      await reload()
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '数据分发操作失败')
    } finally {
      setBusyId(null)
    }
  }

  function onActionClick(row: ExportRow, action: string) {
    if (action === '取消分发') {
      setCancelTarget(row)
      setCancelReason('')
      return
    }
    void runSingleAction(row, action)
  }

  async function confirmCancel() {
    if (!cancelTarget) return
    const target = cancelTarget
    const reason = cancelReason.trim() || '未填写取消原因'
    setCancelTarget(null)
    await runSingleAction(target, '取消分发', reason)
  }

  async function runBatch(action: string) {
    const ids = [...selected]
    if (!ids.length) {
      setErrorMessage('请先勾选至少一条分发任务')
      return
    }
    setErrorMessage('')
    setNotice('')
    try {
      const remark = action === '取消分发' ? '批量取消：统一窗口关闭' : null
      const resp = await request(`${ENDPOINT}/batch-actions`, {
        method: 'POST',
        body: JSON.stringify({ items: ids.map((entry_id) => ({ entry_id, action, remark })) }),
      })
      if (!resp.ok) throw new Error('批量动作提交失败')
      const data = await resp.json()
      const codeById = new Map(rows.map((r) => [r.id, r.任务编号]))
      setBatchOutcomes(
        (data.results ?? []).map((r: BatchItemResult & { entry_id: number }) => ({
          ...r,
          任务编号: codeById.get(r.entry_id),
        })),
      )
      setSelected(new Set())
      await reload()
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '批量动作失败')
    }
  }

  return (
    <section className="page" data-module="exporttask">
      <header className="page-head">
        <div>
          <h2>数据分发管理</h2>
          <p className="page-desc">分发任务按 草稿 → 任务审批中 → 执行中 → 已完成/已取消 推进，启动前强制校验连接器可投递并冻结接入版本。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setShowBatchCreate(true)}>批量登记分发任务</button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>导出分发清单</button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); void reload() }}>
        <label className="filter-item">
          <span>任务编号</span>
          <input value={filters.keyword} placeholder="按任务编号检索"
            onChange={(e) => setFilters((p) => ({ ...p, keyword: e.target.value }))} />
        </label>
        <label className="filter-item">
          <span>状态</span>
          <select value={filters.status} onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))}>
            <option value="">全部状态</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({ keyword: '', status: '' })}>重置条件</button>
      </form>

      {selected.size > 0 && (
        <div className="batch-bar">
          <span>已选 {selected.size} 条，可批量执行：</span>
          <button className="btn" type="button" onClick={() => void runBatch('提交任务审批')}>批量提交审批</button>
          <button className="btn" type="button" onClick={() => void runBatch('启动分发')}>批量启动分发</button>
          <button className="btn" type="button" onClick={() => void runBatch('取消分发')}>批量取消</button>
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th className="col-check"><input type="checkbox" aria-label="全选"
              checked={selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id))}
              onChange={toggleAll} /></th>
            {columns.map((c) => <th key={c}>{c}</th>)}
            <th>状态</th><th>冻结版本</th><th>可执行动作</th><th>入口</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.status === '已取消' ? 'row-canceled' : ''}>
              <td className="col-check">
                <input type="checkbox" disabled={ACTIONS_BY_STATUS[row.status].length === 0}
                  checked={selected.has(row.id)} onChange={() => toggleOne(row.id)} aria-label={`选择 ${row.任务编号}`} />
              </td>
              {columns.map((c) => <td key={c}>{String(row[c as keyof ExportRow] ?? '—')}</td>)}
              <td><span className={`status-tag status-${row.status}`}>{row.status}</span></td>
              <td>{row.冻结连接器版本 != null ? `v${row.冻结连接器版本}` : <span className="muted">未冻结</span>}</td>
              <td className="row-actions">
                {ACTIONS_BY_STATUS[row.status].length === 0 ? (
                  <span className="muted">终态，无可用动作</span>
                ) : (
                  ACTIONS_BY_STATUS[row.status].map((action) => (
                    <button key={action} className={`link ${action === '取消分发' ? 'danger' : ''}`} type="button"
                      disabled={busyId === row.id}
                      onClick={() => onActionClick(row, action)}>
                      {action}
                    </button>
                  ))
                )}
              </td>
              <td><button className="link" type="button" onClick={() => setDetailId(row.id)}>查看详情</button></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td className="empty-state" colSpan={columns.length + 5}>暂无符合条件的分发任务</td></tr>
          )}
        </tbody>
      </table>

      {batchOutcomes.length > 0 && (
        <section className="detail-block batch-result">
          <h4>批量处理结果（成功 {batchOutcomes.filter((o) => o.ok).length} / 失败 {batchOutcomes.filter((o) => !o.ok).length}）</h4>
          <ul className="record-list">
            {batchOutcomes.map((o, i) => (
              <li key={i} className={o.ok ? 'result-ok' : 'result-fail'}>
                <strong>{o.ok ? '成功' : '失败'}</strong>
                <span>{o.任务编号 ?? `#${o.entry_id}`}｜{o.action}</span>
                <span>{o.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条数据分发记录</span>
        {notice && <span className="ok-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>

      <TaskDetailDrawer taskId={detailId} onClose={() => setDetailId(null)} />
      {showBatchCreate && (
        <BatchCreateModal onClose={() => setShowBatchCreate(false)} onSubmitted={() => void reload()} />
      )}

      {cancelTarget && (
        <div className="drawer-mask" role="presentation" onClick={() => setCancelTarget(null)}>
          <div className="modal small" role="dialog" aria-label="取消原因" onClick={(e) => e.stopPropagation()}>
            <header className="drawer-head"><h3>取消分发：{cancelTarget.任务编号}</h3></header>
            <div className="modal-body">
              <p className="muted">取消为终态操作，取消后不可恢复为可执行状态；取消原因与未发送分片会被保留。</p>
              <textarea rows={4} className="reason-input" placeholder="请填写取消原因"
                value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setCancelTarget(null)}>再想想</button>
                <button type="button" className="btn primary danger-btn" onClick={() => void confirmCancel()}>确认取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
