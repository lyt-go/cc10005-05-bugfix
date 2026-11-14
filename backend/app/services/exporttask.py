"""数据分发业务规则：状态机、连接器可用性闸门、版本冻结与并发控制都收在这里。

分发任务状态机只允许按以下顺序推进，任何跳级（例如草稿直接启动）都会被拦截：

    草稿 --提交任务审批--> 任务审批中 --启动分发--> 执行中 --完成投递--> 已完成
                                   \--取消分发--> 已取消
    草稿 ----------------------------取消分发--> 已取消

关键约束：
1. 启动分发前必须确认引用的数据连接器处于「已就绪」可投递状态，离线/测试中一律拦截；
2. 「执行开始」与「连接器版本冻结」在同一把锁内一次完成，冻结失败任务保持原状，
   不会留下已执行却没有接入版本的任务；
3. 同一任务并发启动只允许一次真正执行，后到的请求拿到的是状态冲突错误；
4. 取消后任务为终态，不允许再恢复成可执行状态；取消原因、历史投递清单和
   尚未发送的分片清单原样保留。
"""
from __future__ import annotations

import threading
from typing import Any

from app.services.connector import ConnectorService, DELIVERY_READY_STATUS
from app.store import store

MODULE = "exporttask"
REQUIRED_FIELDS = ["任务编号", "数据源标识", "目标系统", "连接器编号"]
DRAFT, APPROVING, RUNNING, DONE, CANCELED = "草稿", "任务审批中", "执行中", "已完成", "已取消"
STATUS_ORDER = [DRAFT, APPROVING, RUNNING, DONE, CANCELED]
TERMINAL_STATUSES = (DONE, CANCELED)

# 状态机：current_status -> {action: target_status}，不在表里的组合一律拒绝。
TRANSITIONS: dict[str, dict[str, str]] = {
    DRAFT: {"提交任务审批": APPROVING, "取消分发": CANCELED},
    APPROVING: {"启动分发": RUNNING, "取消分发": CANCELED},
    RUNNING: {"完成投递": DONE, "取消分发": CANCELED},
    DONE: {},
    CANCELED: {},
}

# 全局锁保护「读状态-校验-冻结-落状态」整段临界区，杜绝并发重复执行。
_state_lock = threading.RLock()
_connector_service = ConnectorService()


class ExporttaskService:
    # ------------------------------------------------------------------ 查询
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
            rows = [row for row in rows if keyword in str(row.get("任务编号", ""))]
        if status:
            rows = [row for row in rows if row.get("status") == status]
        total = len(rows)
        start = max(page - 1, 0) * size
        return rows[start:start + size], total

    def get_entry(self, entry_id: int) -> dict[str, Any] | None:
        return store.find(MODULE, entry_id)

    def get_by_code(self, task_code: str) -> dict[str, Any] | None:
        code = str(task_code or "").strip()
        if not code:
            return None
        for row in store.rows(MODULE):
            if str(row.get("任务编号", "")).strip() == code:
                return row
        return None

    # ------------------------------------------------------------------ 登记
    def create_entry(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
        missing = [field for field in REQUIRED_FIELDS if not str(values.get(field) or "").strip()]
        if missing:
            return None, missing
        rows = store.rows(MODULE)
        if any(str(row.get("任务编号", "")).strip() == str(values["任务编号"]).strip() for row in rows):
            return None, ["任务编号重复"]
        entry = {"id": max((int(row.get("id", 0)) for row in rows), default=0) + 1}
        entry.update({
            "任务编号": str(values["任务编号"]).strip(),
            "数据源标识": str(values["数据源标识"]).strip(),
            "目标系统": str(values["目标系统"]).strip(),
            "连接器编号": str(values["连接器编号"]).strip(),
            "传输协议": values.get("传输协议") or "HTTPS",
            "压缩格式": values.get("压缩格式") or "gzip",
            "分片大小MB": values.get("分片大小MB") or 64,
            "加密开关": values.get("加密开关") or "开启",
            "校验方式": values.get("校验方式") or "SHA-256",
        })
        entry["status"] = DRAFT
        entry["pending"] = True
        entry["abnormal"] = False
        # 分发执行相关字段：只有真正启动后才会被填充。
        entry["冻结连接器版本"] = None
        entry["连接器最后连通时间"] = None
        entry["取消原因"] = None
        entry["分片清单"] = []
        entry["投递记录"] = []
        rows.append(entry)
        return entry, []

    # -------------------------------------------------------------- 单条动作
    def run_action(
        self, entry_id: int, action: str, *, remark: str | None = None
    ) -> tuple[dict[str, Any] | None, str]:
        with _state_lock:
            entry = store.find(MODULE, entry_id)
            if entry is None:
                return None, f"分发任务 {entry_id} 不存在或已归档"
            current = str(entry.get("status"))
            if current in TERMINAL_STATUSES:
                reason = f"，原取消原因：{entry.get('取消原因')}" if current == CANCELED and entry.get("取消原因") else ""
                return None, f"任务已处于终态「{current}」{reason}，不允许再执行任何动作"
            allowed = TRANSITIONS.get(current, {})
            if action not in allowed:
                return None, (
                    f"任务当前为「{current}」，不允许执行「{action}」，"
                    f"请按 {STATUS_ORDER} 的顺序推进"
                )
            target = allowed[action]
            if action == "启动分发":
                error = self._start_delivery(entry)
                if error:
                    return None, error
            elif action == "取消分发":
                self._cancel(entry, remark)
            elif action == "完成投递":
                self._complete(entry)
            else:
                entry["status"] = target
            self._refresh_flags(entry)
            return entry, self._success_message(action, entry)

    # -------------------------------------------------------------- 批量动作
    def batch_run_actions(
        self, items: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """逐条执行动作，彼此隔离：单条失败只记录原因，不影响其它条目落状态。"""
        results: list[dict[str, Any]] = []
        for item in items or []:
            entry_id = item.get("entry_id")
            action = str(item.get("action") or "").strip()
            remark = item.get("remark")
            try:
                eid = int(entry_id)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                results.append({
                    "entry_id": entry_id, "action": action, "ok": False,
                    "message": "entry_id 必须是数字", "entry": None,
                })
                continue
            entry, message = self.run_action(eid, action, remark=remark)
            results.append({
                "entry_id": eid,
                "action": action,
                "ok": entry is not None,
                "message": message,
                "entry": entry,
            })
        return results

    def batch_create(
        self, items: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """批量登记分发任务：失败项单独保留原因，成功项各自生成草稿任务。"""
        results: list[dict[str, Any]] = []
        for values in items or []:
            values = values or {}
            entry, problems = self.create_entry(values)
            if entry is None:
                results.append({
                    "任务编号": values.get("任务编号"),
                    "数据源标识": values.get("数据源标识"),
                    "连接器编号": values.get("连接器编号"),
                    "ok": False,
                    "message": "、".join(problems) if problems != ["任务编号重复"] else "任务编号已存在，未重复登记",
                    "entry": None,
                })
            else:
                results.append({
                    "任务编号": entry["任务编号"],
                    "数据源标识": entry["数据源标识"],
                    "连接器编号": entry["连接器编号"],
                    "ok": True,
                    "message": "分发任务已登记为草稿",
                    "entry": entry,
                })
        return results

    # -------------------------------------------------------------- 内部规则
    def _start_delivery(self, entry: dict[str, Any]) -> str:
        """执行开始 + 版本冻结的原子流程，返回空串表示成功，否则返回错误原因。

        所有校验先做完、冻结快照先拿到手，最后才一次性写任务字段；任何一步失败
        都直接 return，任务保持「任务审批中」，不会出现执行中却没有冻结版本。
        """
        if str(entry.get("status")) != APPROVING:
            # 双检：锁外可能已有另一个请求把任务推进走了。
            return f"任务当前为「{entry.get('status')}」，仅「{APPROVING}」可启动分发"
        connector_code = str(entry.get("连接器编号") or "").strip()
        connector, frozen, error = _connector_service.freeze_version(connector_code)
        if error:
            # 连接器离线/不存在/无版本：拦截，任务状态不变。
            return f"启动分发被拦截：{error}"
        assert connector is not None and frozen is not None
        # 冻结成功后才落执行态与分片清单，保证两者同时成立。
        entry["status"] = RUNNING
        entry["冻结连接器版本"] = frozen["连接器版本"]
        entry["连接器最后连通时间"] = frozen["最后连通时间"]
        entry["冻结快照"] = frozen
        entry["分片清单"] = self._build_shards(entry)
        entry["投递记录"] = entry.get("投递记录") or []
        entry["投递记录"].append({
            "事件": "启动分发",
            "连接器编号": connector_code,
            "冻结版本": frozen["连接器版本"],
            "连接器状态": connector.get("status"),
        })
        return ""

    def _cancel(self, entry: dict[str, Any], remark: str | None) -> None:
        reason = str(remark or "").strip() or "未填写取消原因"
        unsent = [shard for shard in entry.get("分片清单", []) if shard.get("发送状态") != "已发送"]
        entry["status"] = CANCELED
        entry["取消原因"] = reason
        # 尚未发送的分片清单原样保留，不删除；历史投递记录同样保留。
        entry["未发送分片"] = unsent
        entry.setdefault("投递记录", []).append({"事件": "取消分发", "取消原因": reason})

    def _complete(self, entry: dict[str, Any]) -> None:
        for shard in entry.get("分片清单", []):
            shard["发送状态"] = "已发送"
        entry["status"] = DONE
        entry.setdefault("投递记录", []).append({"事件": "完成投递"})

    @staticmethod
    def _build_shards(entry: dict[str, Any]) -> list[dict[str, Any]]:
        size = entry.get("分片大小MB") or 64
        try:
            size = int(size)
        except (TypeError, ValueError):
            size = 64
        return [
            {"分片编号": f"{entry['任务编号']}-S1", "大小MB": size, "发送状态": "待发送"},
            {"分片编号": f"{entry['任务编号']}-S2", "大小MB": size, "发送状态": "待发送"},
            {"分片编号": f"{entry['任务编号']}-S3", "大小MB": size, "发送状态": "待发送"},
        ]

    @staticmethod
    def _refresh_flags(entry: dict[str, Any]) -> None:
        entry["pending"] = entry["status"] not in TERMINAL_STATUSES
        entry["abnormal"] = entry["status"] == CANCELED

    @staticmethod
    def _success_message(action: str, entry: dict[str, Any]) -> str:
        if action == "启动分发":
            return (
                f"分发任务已启动，冻结连接器 {entry.get('连接器编号')} "
                f"v{entry.get('冻结连接器版本')}，生成 {len(entry.get('分片清单', []))} 个分片"
            )
        if action == "取消分发":
            return f"分发任务已取消，原因已保留，未发送分片 {len(entry.get('未发送分片', []))} 个"
        return f"分发任务已{action}"
