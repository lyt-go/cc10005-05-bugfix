import { useCallback, useEffect, useMemo, useState } from 'react'

import { postAction, request } from '@/api/client'

const ENDPOINT = '/api/connector'
const columns = [
  "连接器编号",
  "协议类型",
  "目标端点",
  "数据编码",
  "连接器版本",
  "最后连通时间"
]
const statuses = ["草稿", "连通测试中", "已就绪", "已离线"] as const
type ConnectorStatus = (typeof statuses)[number]

/** 与后端连接器状态机一致：只暴露当前状态真正允许的动作。 */
const ACTIONS_BY_STATUS: Record<ConnectorStatus, string[]> = {
  草稿: ["发起连通测试"],
  连通测试中: ["标记就绪", "标记离线"],
  已就绪: ["发起连通测试", "标记离线"],
  已离线: ["发起连通测试"],
}

type Row = Record<string, string | number | null> & { status: ConnectorStatus }

export default function ConnectorView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<number | null>(null)
  const filterFields = useMemo(() => ["连接器编号", "协议类型", "目标端点"], [])

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const response = await request(`${ENDPOINT}?${query}`)
      if (!response.ok) {
        throw new Error('数据连接器列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '连接器管理列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  const stats = useMemo(() => [
    { label: "连接器总数", value: rows.length },
    { label: "已就绪（可投递）", value: rows.filter((r) => r.status === "已就绪").length },
    { label: "已离线", value: rows.filter((r) => r.status === "已离线").length },
  ], [rows])

  async function runAction(action: string, row: Row) {
    setBusyId(Number(row.id))
    setErrorMessage('')
    setNotice('')
    try {
      const result = await postAction(`${ENDPOINT}/${row.id}/actions`, { values: { action } })
      if (!result.ok) {
        setErrorMessage(result.message)
        return
      }
      setNotice(result.message)
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '连接器管理操作失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="page" data-module="connector">
      <header className="page-head">
        <div>
          <h2>连接器管理</h2>
          <p className="page-desc">管理各类数据源连接器；仅「已就绪」连接器可承接分发投递，每次重新就绪会生成新的接入版本。</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出连接器清单
          </button>
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

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} className={row.status === '已离线' ? 'row-canceled' : ''}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td><span className={`status-tag status-${row.status}`}>{row.status}</span></td>
              <td className="row-actions">
                {ACTIONS_BY_STATUS[row.status].map((action) => (
                  <button
                    key={action}
                    className={`link ${action === '标记离线' ? 'danger' : ''}`}
                    type="button"
                    disabled={busyId === Number(row.id)}
                    onClick={() => void runAction(action, row)}
                  >
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无连接器数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条连接器记录</span>
        {notice && <span className="ok-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
