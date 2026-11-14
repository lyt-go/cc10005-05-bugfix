import { useEffect, useState } from 'react'

import { request } from '@/api/client'
import type { ExportRow, Shard } from './model'

type Props = {
  /** 打开时传入任务 id；关闭时为 null。切换 id 会重新拉取，杜绝旧值残留。 */
  taskId: number | null
  onClose: () => void
}

/**
 * 分发任务详情抽屉。每次打开/切换任务都按 id 重新请求后端明细，
 * 展示连接器最后连通时间、任务冻结版本、取消原因与分片/投递历史。
 */
export default function TaskDetailDrawer({ taskId, onClose }: Props) {
  const [detail, setDetail] = useState<ExportRow | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (taskId == null) {
      // 关闭即清空，避免下次打开先闪一下上一条数据。
      setDetail(null)
      setError('')
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    request(`/api/exporttask/${taskId}`)
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`详情读取失败（${resp.status}）`)
        const data = (await resp.json()) as ExportRow
        if (!cancelled) setDetail(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '详情读取失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [taskId])

  if (taskId == null) return null

  const unsent: Shard[] = detail?.未发送分片 ?? []
  const shards: Shard[] = detail?.分片清单 ?? []

  return (
    <div className="drawer-mask" role="presentation" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="分发任务详情" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h3>分发任务详情{detail ? `：${detail.任务编号}` : ''}</h3>
          <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
        </header>

        {loading && <p className="muted">详情加载中…</p>}
        {error && <p className="error-text">{error}</p>}

        {detail && (
          <div className="drawer-body">
            <section className="detail-block">
              <h4>基础信息</h4>
              <dl className="detail-grid">
                <dt>任务状态</dt><dd><span className={`status-tag status-${detail.status}`}>{detail.status}</span></dd>
                <dt>数据源标识</dt><dd>{detail.数据源标识}</dd>
                <dt>目标系统</dt><dd>{detail.目标系统}</dd>
                <dt>连接器编号</dt><dd>{detail.连接器编号}</dd>
                <dt>传输协议</dt><dd>{detail.传输协议 ?? '—'}</dd>
                <dt>压缩格式</dt><dd>{detail.压缩格式 ?? '—'}</dd>
              </dl>
            </section>

            <section className="detail-block">
              <h4>接入与冻结信息</h4>
              <dl className="detail-grid">
                <dt>任务冻结版本</dt>
                <dd>{detail.冻结连接器版本 != null ? `v${detail.冻结连接器版本}` : <span className="muted">尚未启动，无冻结版本</span>}</dd>
                <dt>连接器最后连通时间</dt>
                <dd>{detail.连接器最后连通时间 ?? <span className="muted">—</span>}</dd>
              </dl>
            </section>

            <section className="detail-block">
              <h4>取消信息</h4>
              {detail.status === '已取消' || detail.取消原因 ? (
                <dl className="detail-grid">
                  <dt>取消原因</dt><dd className="cancel-reason">{detail.取消原因 ?? '—'}</dd>
                  <dt>未发送分片</dt>
                  <dd>{unsent.length ? `${unsent.length} 个：${unsent.map((s) => s.分片编号).join('、')}` : '无'}</dd>
                </dl>
              ) : (
                <p className="muted">任务未取消。</p>
              )}
            </section>

            <section className="detail-block">
              <h4>分片清单</h4>
              {shards.length ? (
                <table className="data-table compact">
                  <thead><tr><th>分片编号</th><th>大小MB</th><th>发送状态</th></tr></thead>
                  <tbody>
                    {shards.map((s) => (
                      <tr key={s.分片编号}>
                        <td>{s.分片编号}</td><td>{s.大小MB}</td>
                        <td><span className={`shard-tag shard-${s.发送状态}`}>{s.发送状态}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">尚未启动，暂未生成分片。</p>}
            </section>

            <section className="detail-block">
              <h4>历史投递记录</h4>
              {detail.投递记录?.length ? (
                <ul className="record-list">
                  {detail.投递记录.map((r, i) => (
                    <li key={i}>{r.事件}{r.取消原因 ? `（原因：${r.取消原因}）` : ''}{r.冻结版本 ? `，冻结 v${r.冻结版本}` : ''}</li>
                  ))}
                </ul>
              ) : <p className="muted">暂无投递记录。</p>}
            </section>
          </div>
        )}
      </aside>
    </div>
  )
}
