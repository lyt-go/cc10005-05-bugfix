import { useCallback, useEffect, useState } from 'react'

import { postAction, request } from '@/api/client'
import { ACTIONS_BY_STATUS, type ExportRow, STATUSES, type TaskStatus } from './model'
import TaskDetailDrawer from './TaskDetailDrawer'

type WorkbenchPayload = {
  summary: Record<string, number>
  approving: ExportRow[]
  running: ExportRow[]
  canceled: ExportRow[]
}

/**
 * 分发工作台（第二个入口）。进入即拉 /workbench 最新数据，
 * 所有动作后整页重取，避免详情/列表两个入口数据不一致和旧值残留。
 */
export default function ExportWorkbench() {
  const [data, setData] = useState<WorkbenchPayload | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)

  const reload = useCallback(async () => {
    setError('')
    try {
      const resp = await request('/api/exporttask/workbench')
      if (!resp.ok) throw new Error('工作台数据读取失败')
      setData((await resp.json()) as WorkbenchPayload)
    } catch (e) {
      setError(e instanceof Error ? e.message : '工作台数据读取失败')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function act(row: ExportRow, action: string) {
    setError('')
    setNotice('')
    const remark = action === '取消分发' ? '工作台批量取消' : null
    const result = await postAction(`/api/exporttask/${row.id}/actions`, { values: { action }, remark })
    if (!result.ok) {
      setError(`${row.任务编号}：${result.message}`)
    } else {
      setNotice(`${row.任务编号}：${result.message}`)
    }
    await reload()
  }

  return (
    <section className="page" data-module="exporttask-workbench">
      <header className="page-head">
        <div>
          <h2>分发工作台</h2>
          <p className="page-desc">集中处理待审批与执行中的分发任务；取消任务只保留展示，不会恢复成可执行状态。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void reload()}>刷新工作台</button>
        </div>
      </header>

      <div className="stat-row">
        {STATUSES.map((s) => (
          <article key={s} className="stat-card">
            <span className="stat-label">{s}</span>
            <strong className="stat-value">{data?.summary?.[s] ?? 0}</strong>
          </article>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="ok-text">{notice}</p>}

      <Group title="待审批任务（启动前校验连接器并冻结版本）" rows={data?.approving ?? []} onAction={act} onDetail={setDetailId} />
      <Group title="执行中任务（已冻结接入版本）" rows={data?.running ?? []} onAction={act} onDetail={setDetailId} />

      <section className="detail-block">
        <h4>已取消任务（终态，不可恢复）</h4>
        {(data?.canceled ?? []).length === 0 ? (
          <p className="muted">暂无已取消任务。</p>
        ) : (
          <table className="data-table compact">
            <thead><tr><th>任务编号</th><th>连接器编号</th><th>取消原因</th><th>未发送分片</th><th>入口</th></tr></thead>
            <tbody>
              {data!.canceled.map((row) => (
                <tr key={row.id} className="row-canceled">
                  <td>{row.任务编号}</td>
                  <td>{row.连接器编号}</td>
                  <td className="cancel-reason">{row.取消原因 ?? '—'}</td>
                  <td>{(row.未发送分片 ?? []).length} 个</td>
                  <td><button className="link" type="button" onClick={() => setDetailId(row.id)}>查看详情</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <TaskDetailDrawer taskId={detailId} onClose={() => setDetailId(null)} />
    </section>
  )
}

function Group({
  title,
  rows,
  onAction,
  onDetail,
}: {
  title: string
  rows: ExportRow[]
  onAction: (row: ExportRow, action: string) => void
  onDetail: (id: number) => void
}) {
  return (
    <section className="detail-block">
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">暂无任务。</p>
      ) : (
        <table className="data-table compact">
          <thead>
            <tr><th>任务编号</th><th>数据源</th><th>连接器</th><th>状态</th><th>冻结版本</th><th>最后连通时间</th><th>操作</th><th>入口</th></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.任务编号}</td>
                <td>{row.数据源标识}</td>
                <td>{row.连接器编号}</td>
                <td><span className={`status-tag status-${row.status}`}>{row.status}</span></td>
                <td>{row.冻结连接器版本 != null ? `v${row.冻结连接器版本}` : <span className="muted">未冻结</span>}</td>
                <td>{row.连接器最后连通时间 ?? <span className="muted">—</span>}</td>
                <td className="row-actions">
                  {ACTIONS_BY_STATUS[row.status as TaskStatus].map((action) => (
                    <button key={action} type="button" className={`link ${action === '取消分发' ? 'danger' : ''}`}
                      onClick={() => onAction(row, action)}>{action}</button>
                  ))}
                </td>
                <td><button className="link" type="button" onClick={() => onDetail(row.id)}>查看详情</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
