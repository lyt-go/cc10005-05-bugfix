"""连接器管理业务规则：状态流转、版本冻结口径与字段校验都收在这里。

连接器状态机只允许：
    草稿 -> 连通测试中 -> 已就绪 -> 已离线
其中「已就绪」是唯一可被分发任务投递的状态。每次重新标记就绪都会产生一个
新的接入版本，分发任务启动时通过 :meth:`ConnectorService.freeze_version` 冻结
该版本，保证任务执行期引用的接入配置不会被后续变更覆盖。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from app.store import store

MODULE = "connector"
REQUIRED_FIELDS = ["连接器编号", "协议类型", "目标端点"]
STATUS_ORDER = ["草稿", "连通测试中", "已就绪", "已离线"]
# 唯一允许的状态迁移：任何不在表里的动作/状态组合都视为跳级，直接拦截。
TRANSITIONS: dict[str, dict[str, str]] = {
    "草稿": {"发起连通测试": "连通测试中"},
    "连通测试中": {"标记就绪": "已就绪", "标记离线": "已离线"},
    "已就绪": {"发起连通测试": "连通测试中", "标记离线": "已离线"},
    "已离线": {"发起连通测试": "连通测试中"},
}
# 只有「已就绪」的连接器才允许承接分发投递。
DELIVERY_READY_STATUS = "已就绪"


class ConnectorService:
    def list_entries(
        self,
        *,
        keyword: str | None = None,
        status: str | None = None,
        page: int = 1,
        size: int = 20,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = store.rows(MODULE)
        if keyword:
            rows = [row for row in rows if keyword in str(row.get("连接器编号", ""))]
        if status:
            rows = [row for row in rows if row.get("status") == status]
        total = len(rows)
        start = max(page - 1, 0) * size
        return rows[start:start + size], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        return store.find(MODULE, entry_id)

    def get_by_code(self, connector_code: str) -> dict[str, Any] | None:
        """按连接器编号取记录，供分发任务启动前校验可用性。"""
        code = str(connector_code or "").strip()
        if not code:
            return None
        for row in store.rows(MODULE):
            if str(row.get("连接器编号", "")).strip() == code:
                return row
        return None

    def create_entry(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
        missing = [field for field in REQUIRED_FIELDS if not str(values.get(field) or "").strip()]
        if missing:
            return None, missing
        rows = store.rows(MODULE)
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry.update({field: values.get(field) for field in REQUIRED_FIELDS})
        entry["status"] = STATUS_ORDER[0]
        entry["pending"] = True
        entry["abnormal"] = False
        # 新连接器尚未通过连通测试：没有版本、没有连通时间。
        entry["连接器版本"] = 0
        entry["最后连通时间"] = None
        rows.append(entry)
        return entry, []

    def run_action(self, entry_id: int, action: str) -> tuple[dict[str, Any] | None, str]:
        entry = store.find(MODULE, entry_id)
        if entry is None:
            return None, f"数据连接器 {entry_id} 不存在或已归档"
        current = str(entry.get("status"))
        allowed = TRANSITIONS.get(current, {})
        if action not in allowed:
            return None, f"连接器当前为「{current}」，不允许执行「{action}」，请按 {STATUS_ORDER} 顺序流转"
        target = allowed[action]
        entry["status"] = target
        entry["pending"] = target != "已离线"
        entry["abnormal"] = target == "已离线"
        now = _now()
        if target == "连通测试中":
            entry["最后连通时间"] = now
        if target == "已就绪":
            # 每次就绪都生成一个新版本，作为分发任务可冻结的接入版本。
            entry["连接器版本"] = int(entry.get("连接器版本") or 0) + 1
            entry["最后连通时间"] = now
        return entry, f"数据连接器已{action}"

    def ensure_deliverable(self, connector_code: str) -> tuple[dict[str, Any] | None, str]:
        """分发启动前的可用性闸门：连接器必须存在且处于「已就绪」。"""
        connector = self.get_by_code(connector_code)
        if connector is None:
            return None, f"数据连接器「{connector_code}」不存在，无法投递"
        if str(connector.get("status")) != DELIVERY_READY_STATUS:
            return None, (
                f"数据连接器「{connector_code}」当前为「{connector.get('status')}」，"
                f"仅「{DELIVERY_READY_STATUS}」状态可承接分发投递"
            )
        version = int(connector.get("连接器版本") or 0)
        if version <= 0:
            return None, f"数据连接器「{connector_code}」尚未生成可冻结的接入版本"
        return connector, ""

    def freeze_version(
        self, connector_code: str
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str]:
        """冻结连接器当前接入版本。

        返回 ``(连接器, 冻结快照, 错误信息)``。冻结快照会整体复制到分发任务上，
        之后连接器再下线或升版都不影响已经执行的任务。该方法不修改连接器本身，
        保证「执行开始」和「版本冻结」要么一起成功、要么一起不落地。
        """
        connector, error = self.ensure_deliverable(connector_code)
        if connector is None:
            return None, None, error
        snapshot = {
            "连接器编号": connector.get("连接器编号"),
            "连接器版本": int(connector.get("连接器版本") or 0),
            "连接器状态": connector.get("status"),
            "协议类型": connector.get("协议类型"),
            "目标端点": connector.get("目标端点"),
            "最后连通时间": connector.get("最后连通时间"),
            "冻结时间": _now(),
        }
        return connector, snapshot, ""


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
