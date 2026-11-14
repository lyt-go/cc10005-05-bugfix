/** 统一请求封装：拼后端地址、抛网络错误、给页脚留一句可读的说明。 */
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export function request(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  return fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : '请求未送达'
    throw new Error(`接口请求失败：${detail}`)
  })
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await request(path)
  if (!response.ok) {
    throw new Error(`接口返回 ${response.status}，数据未更新`)
  }
  return (await response.json()) as T
}

export type ActionResult = {
  ok: boolean
  message: string
  entry?: Record<string, unknown> | null
}

/**
 * 动作类接口统一入口。后端业务失败时 HTTP 仍是 200、仅 body.ok=false，
 * 只判断 response.ok 会让“点了没反应”，因此这里必须解析 body 并把 message 抛回页面。
 */
export async function postAction(path: string, body: unknown): Promise<ActionResult> {
  const response = await request(path, { method: 'POST', body: JSON.stringify(body) })
  const data = (await response.json().catch(() => null)) as ActionResult | null
  if (!response.ok || !data || typeof data.ok !== 'boolean') {
    throw new Error(`接口返回 ${response.status}，操作未生效，请稍后重试`)
  }
  return data
}
