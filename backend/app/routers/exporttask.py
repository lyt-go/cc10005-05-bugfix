"""数据分发接口：维护分发任务，覆盖提交任务审批、启动分发、取消分发等动作。

状态流转与连接器可用性判断全部在 service 层完成，路由层只负责出入参。
批量接口逐条处理，失败项单独保留原因，不影响其它条目落各自状态。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.schemas import (
    ActionResult,
    BatchActionPayload,
    BatchCreatePayload,
    BatchResult,
    EntryPayload,
    PageResult,
)
from app.services.exporttask import APPROVING, CANCELED, DONE, DRAFT, RUNNING, ExporttaskService

router = APIRouter(prefix="/api/exporttask", tags=["数据分发"])

service = ExporttaskService()

LIST_FIELDS = ["任务编号", "数据源标识", "目标系统", "连接器编号", "传输协议", "压缩格式", "分片大小MB", "加密开关", "校验方式"]
STATUSES = [DRAFT, APPROVING, RUNNING, DONE, CANCELED]


@router.get("", response_model=PageResult[dict])
def list_entries(
    keyword: str | None = Query(default=None, description="按任务编号检索"),
    status: str | None = Query(default=None, description="草稿、任务审批中、执行中、已完成、已取消"),
    page: int = 1,
    size: int = 20,
) -> PageResult[dict]:
    """按任务编号与状态过滤数据分发列表；没有数据时返回空页，不报错。"""
    if size > 200:
        raise HTTPException(status_code=400, detail="每页最多 200 条，请缩小分页范围")
    items, total = service.list_entries(keyword=keyword, status=status, page=page, size=size)
    return PageResult(items=items, total=total, page=page, size=size)


@router.get("/workbench", response_model=dict)
def workbench() -> dict[str, Any]:
    """分发工作台：汇总各状态任务量，并列出待审批与执行中的任务供快速处理。"""
    all_rows, _ = service.list_entries(page=1, size=10000)
    counter = {status: 0 for status in STATUSES}
    for row in all_rows:
        counter[str(row.get("status"))] = counter.get(str(row.get("status")), 0) + 1
    return {
        "summary": counter,
        "approving": [row for row in all_rows if row.get("status") == APPROVING],
        "running": [row for row in all_rows if row.get("status") == RUNNING],
        "canceled": [row for row in all_rows if row.get("status") == CANCELED],
    }


@router.get("/export")
def export_entries() -> dict[str, Any]:
    """导出数据分发清单：返回当前过滤条件下的全量数据。"""
    items, total = service.list_entries(page=1, size=10000)
    return {"module": "exporttask", "total": total, "items": items}


@router.post("/batch-create", response_model=BatchResult)
def batch_create(payload: BatchCreatePayload) -> BatchResult:
    """批量登记分发任务（多连接器/多任务/多数据源标识一次提交），逐条给出结果。"""
    results = service.batch_create(payload.items)
    success = sum(1 for item in results if item["ok"])
    return BatchResult(
        total=len(results), success=success, failed=len(results) - success, results=results
    )


@router.post("/batch-actions", response_model=BatchResult)
def batch_actions(payload: BatchActionPayload) -> BatchResult:
    """批量对已有任务执行动作：逐条独立处理，失败项保留原因，其余条目照常落状态。"""
    items = [item.model_dump() for item in payload.items]
    results = service.batch_run_actions(items)
    success = sum(1 for item in results if item["ok"])
    return BatchResult(
        total=len(results), success=success, failed=len(results) - success, results=results
    )


@router.get("/{entry_id}", response_model=dict)
def get_entry(entry_id: int) -> dict:
    """读取单条分发任务明细；不存在时给出可读的错误说明。"""
    entry = service.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"分发任务 {entry_id} 不存在或已归档")
    return entry


@router.post("", response_model=ActionResult)
def create_entry(payload: EntryPayload) -> ActionResult:
    """登记一条分发任务，缺字段时说明原因而不是静默丢弃。"""
    entry, missing = service.create_entry(payload.values)
    if missing:
        return ActionResult(ok=False, message=f"缺少必填字段或编号冲突：{'、'.join(missing)}")
    return ActionResult(ok=True, message="分发任务已登记", entry=entry)


@router.post("/{entry_id}/actions", response_model=ActionResult)
def run_action(entry_id: int, payload: EntryPayload) -> ActionResult:
    """对单条分发任务执行动作；非法跳级、连接器离线、终态操作都会被拦下并说明原因。"""
    action = str(payload.values.get("action") or "").strip()
    entry, message = service.run_action(entry_id, action, remark=payload.remark)
    if entry is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=True, message=message, entry=entry)
