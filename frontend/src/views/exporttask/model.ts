/** 数据分发领域常量与前端状态机口径，和后端 service 保持一致。 */
export const ENDPOINT = '/api/exporttask'

export const STATUSES = ['草稿', '任务审批中', '执行中', '已完成', '已取消'] as const
export type TaskStatus = (typeof STATUSES)[number]

export const columns = [
  '任务编号',
  '数据源标识',
  '目标系统',
  '连接器编号',
  '传输协议',
  '压缩格式',
  '分片大小MB',
  '加密开关',
  '校验方式',
] as const

/** 每个状态下真正允许的动作；终态没有任何动作，按钮不再渲染，避免“点不动”。 */
export const ACTIONS_BY_STATUS: Record<TaskStatus, string[]> = {
  草稿: ['提交任务审批', '取消分发'],
  任务审批中: ['启动分发', '取消分发'],
  执行中: ['完成投递', '取消分发'],
  已完成: [],
  已取消: [],
}

export type Shard = {
  分片编号: string
  大小MB: number
  发送状态: string
}

export type DeliveryRecord = {
  事件: string
  [key: string]: unknown
}

export type ExportRow = {
  id: number
  status: TaskStatus
  pending: boolean
  abnormal: boolean
  任务编号: string
  数据源标识: string
  目标系统: string
  连接器编号: string
  传输协议?: string
  压缩格式?: string
  分片大小MB?: number | string
  加密开关?: string
  校验方式?: string
  冻结连接器版本?: number | null
  连接器最后连通时间?: string | null
  取消原因?: string | null
  分片清单?: Shard[]
  未发送分片?: Shard[]
  投递记录?: DeliveryRecord[]
  冻结快照?: Record<string, unknown> | null
}

export type BatchLine = {
  key: number
  任务编号: string
  数据源标识: string
  目标系统: string
  连接器编号: string
}

export type BatchItemResult = {
  ok: boolean
  message: string
  任务编号?: string
  数据源标识?: string
  连接器编号?: string
  entry?: ExportRow | null
}

/** 新建一行空白批量登记项。 */
export function emptyBatchLine(key: number): BatchLine {
  return { key, 任务编号: '', 数据源标识: '', 目标系统: '', 连接器编号: '' }
}
