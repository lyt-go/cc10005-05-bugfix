import { useState } from 'react'

import { request } from '@/api/client'
import { type BatchItemResult, type BatchLine, emptyBatchLine } from './model'

type Props = {
  onClose: () => void
  onSubmitted: () => void
}

/**
 * 批量登记分发任务：可一次填多条「连接器 + 任务 + 数据源标识」组合。
 * 后端逐条处理，失败项单独保留原因，成功项各自成为草稿任务。
 */
export default function BatchCreateModal({ onClose, onSubmitted }: Props) {
  const [lines, setLines] = useState<BatchLine[]>([emptyBatchLine(1), emptyBatchLine(2)])
  const [results, setResults] = useState<BatchItemResult[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  function update(key: number, field: keyof BatchLine, value: string) {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, [field]: value } : line)))
  }

  function addLine() {
    setLines((prev) => [...prev, emptyBatchLine(prev.length ? Math.max(...prev.map((l) => l.key)) + 1 : 1)])
  }

  function removeLine(key: number) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((line) => line.key !== key)))
  }

  async function submit() {
    setSubmitting(true)
    setError('')
    try {
      const items = lines.map(({ key: _key, ...rest }) => rest)
      const resp = await request('/api/exporttask/batch-create', {
        method: 'POST',
        body: JSON.stringify({ items }),
      })
      if (!resp.ok) throw new Error(`批量提交失败（${resp.status}）`)
      const data = await resp.json()
      setResults(data.results ?? [])
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : '批量提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="drawer-mask" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="批量登记分发任务" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h3>批量登记分发任务</h3>
          <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
        </header>

        <div className="modal-body">
          <p className="muted">一次可提交多条数据连接器、分发任务、数据源标识组合；失败项会单独保留原因，其余条目照常生成草稿。</p>
          <table className="data-table compact">
            <thead>
              <tr><th>任务编号</th><th>数据源标识</th><th>目标系统</th><th>连接器编号</th><th></th></tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key}>
                  <td><input value={line.任务编号} onChange={(e) => update(line.key, '任务编号', e.target.value)} placeholder="EXPO-0010" /></td>
                  <td><input value={line.数据源标识} onChange={(e) => update(line.key, '数据源标识', e.target.value)} placeholder="SRC-..." /></td>
                  <td><input value={line.目标系统} onChange={(e) => update(line.key, '目标系统', e.target.value)} placeholder="TGT-..." /></td>
                  <td><input value={line.连接器编号} onChange={(e) => update(line.key, '连接器编号', e.target.value)} placeholder="CONN-0001" /></td>
                  <td><button type="button" className="link danger" onClick={() => removeLine(line.key)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={addLine}>再加一行</button>
            <button type="button" className="btn primary" disabled={submitting} onClick={() => void submit()}>
              {submitting ? '提交中…' : '一次提交'}
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}

          {results.length > 0 && (
            <section className="detail-block">
              <h4>逐条处理结果（成功 {results.filter((r) => r.ok).length} / 失败 {results.filter((r) => !r.ok).length}）</h4>
              <ul className="record-list">
                {results.map((r, i) => (
                  <li key={i} className={r.ok ? 'result-ok' : 'result-fail'}>
                    <strong>{r.ok ? '成功' : '失败'}</strong>
                    <span>{r.任务编号 || '（未填任务编号）'}｜{r.连接器编号 || '—'}</span>
                    <span>{r.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
