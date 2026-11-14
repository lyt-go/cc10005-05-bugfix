"""数据分发状态机与连接器可用性的回归测试。

只用标准库、不依赖网络：直接驱动 service 层。运行方式：

    cd backend && .venv/bin/python -m unittest tests.test_exporttask_flow -v

覆盖：跳级拦截、离线拦截、执行+版本冻结原子性、并发只执行一次、
取消终态与原因/分片保留、批量逐条隔离。
"""
from __future__ import annotations

import threading
import unittest

from app.seed import SEED_ROWS
from app.services.connector import ConnectorService
from app.services.exporttask import (
    APPROVING,
    CANCELED,
    DONE,
    DRAFT,
    RUNNING,
    ExporttaskService,
)
from app import store as store_module


class ExporttaskFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        # 每个用例都用全新的种子数据，避免用例之间通过内存仓库互相污染。
        store_module.store._tables = {
            name: [dict(row) for row in rows] for name, rows in SEED_ROWS.items()
        }
        self.tasks = ExporttaskService()
        self.connectors = ConnectorService()

    def _id(self, code: str) -> int:
        return self.tasks.get_by_code(code)["id"]

    # 1. 跳级：草稿不能直接启动
    def test_draft_cannot_start_directly(self) -> None:
        entry, message = self.tasks.run_action(self._id("EXPO-0001"), "启动分发")
        self.assertIsNone(entry)
        self.assertIn("不允许", message)
        self.assertEqual(self.tasks.get_by_code("EXPO-0001")["status"], DRAFT)
        self.assertIsNone(self.tasks.get_by_code("EXPO-0001")["冻结连接器版本"])

    # 2. 离线拦截：EXPO-0002 引用离线 CONN-0003
    def test_offline_connector_blocks_start(self) -> None:
        entry, message = self.tasks.run_action(self._id("EXPO-0002"), "启动分发")
        self.assertIsNone(entry)
        self.assertIn("CONN-0003", message)
        self.assertIn("已就绪", message)
        task = self.tasks.get_by_code("EXPO-0002")
        self.assertEqual(task["status"], APPROVING)
        self.assertIsNone(task["冻结连接器版本"])
        self.assertEqual(task["分片清单"], [])

    # 3. 原子启动 + 版本冻结
    def test_start_freezes_version_atomically(self) -> None:
        eid = self._id("EXPO-0001")
        self.tasks.run_action(eid, "提交任务审批")
        entry, message = self.tasks.run_action(eid, "启动分发")
        self.assertIsNotNone(entry)
        self.assertEqual(entry["status"], RUNNING)
        self.assertEqual(entry["冻结连接器版本"], 3)
        self.assertTrue(entry["连接器最后连通时间"])
        self.assertEqual(len(entry["分片清单"]), 3)
        # 连接器随后离线/升版，不影响已冻结任务。
        conn = self.connectors.get_by_code("CONN-0001")
        self.connectors.run_action(conn["id"], "标记离线")
        self.assertEqual(self.tasks.get_entry(eid)["冻结连接器版本"], 3)
        self.assertEqual(self.tasks.get_entry(eid)["status"], RUNNING)

    # 4. 并发重复启动只执行一次
    def test_concurrent_start_only_runs_once(self) -> None:
        eid = self._id("EXPO-0003")
        outcomes: list[tuple[object, str]] = []
        barrier = threading.Barrier(2)

        def fire() -> None:
            barrier.wait()
            outcomes.append(self.tasks.run_action(eid, "启动分发"))

        threads = [threading.Thread(target=fire) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        successes = [o for o in outcomes if o[0] is not None]
        self.assertEqual(len(successes), 1)
        task = self.tasks.get_entry(eid)
        self.assertEqual(task["status"], RUNNING)
        self.assertEqual(len(task["分片清单"]), 3)
        self.assertEqual(sum(1 for d in task["投递记录"] if d["事件"] == "启动分发"), 1)

    # 5. 取消是终态：原因、历史投递、未发送分片都保留
    def test_cancel_is_terminal_and_keeps_history(self) -> None:
        eid = self._id("EXPO-0003")
        self.tasks.run_action(eid, "启动分发")
        entry, _ = self.tasks.run_action(eid, "取消分发", remark="窗口关闭")
        self.assertEqual(entry["status"], CANCELED)
        self.assertEqual(entry["取消原因"], "窗口关闭")
        self.assertEqual(len(entry["未发送分片"]), 3)
        self.assertTrue(any(d["事件"] == "启动分发" for d in entry["投递记录"]))
        # 终态后任何动作都被拒绝，且原因在提示中回显。
        again, message = self.tasks.run_action(eid, "启动分发")
        self.assertIsNone(again)
        self.assertIn("窗口关闭", message)
        self.assertEqual(self.tasks.get_entry(eid)["status"], CANCELED)

    # 6. 完成是终态
    def test_complete_is_terminal(self) -> None:
        eid = self._id("EXPO-0001")
        self.tasks.run_action(eid, "提交任务审批")
        self.tasks.run_action(eid, "启动分发")
        entry, _ = self.tasks.run_action(eid, "完成投递")
        self.assertEqual(entry["status"], DONE)
        self.assertTrue(all(s["发送状态"] == "已发送" for s in entry["分片清单"]))
        again, _ = self.tasks.run_action(eid, "取消分发")
        self.assertIsNone(again)

    # 7. 批量动作逐条隔离
    def test_batch_actions_are_isolated(self) -> None:
        id_bad = self._id("EXPO-0002")  # 离线连接器，启动会失败
        id_ok = self._id("EXPO-0003")   # 就绪连接器，启动会成功
        results = self.tasks.batch_run_actions([
            {"entry_id": id_bad, "action": "启动分发"},
            {"entry_id": id_ok, "action": "启动分发"},
            {"entry_id": 99999, "action": "启动分发"},
        ])
        self.assertEqual([r["ok"] for r in results], [False, True, False])
        self.assertEqual(self.tasks.get_entry(id_bad)["status"], APPROVING)
        self.assertEqual(self.tasks.get_entry(id_ok)["status"], RUNNING)

    # 8. 批量登记：失败项单独保留原因
    def test_batch_create_reports_each_line(self) -> None:
        results = self.tasks.batch_create([
            {"任务编号": "EXPO-N1", "数据源标识": "S", "目标系统": "T", "连接器编号": "CONN-0001"},
            {"数据源标识": "S", "目标系统": "T", "连接器编号": "CONN-0001"},  # 缺任务编号
        ])
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])
        self.assertIn("任务编号", results[1]["message"])


if __name__ == "__main__":
    unittest.main()
