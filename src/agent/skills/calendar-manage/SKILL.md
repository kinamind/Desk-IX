---
name: calendar-manage
description: 创建、改期、移动、拆分、合并、取消或批量调整 Desk-IX 内部日程。用户说改到明晚、往后推、避开会议、把下午安排整体移动、取消某段工作或修改提醒时，都应激活此技能，并结合引用与会话解析对象。
compatibility: Desk-IX internal calendar tools and actions
allowed-tools: calendar_snapshot availability_find memory_search item_get item_create item_update item_transition reminder_manage work_session_manage lifecycle_followup_manage profile_get
---

# 管理内部日程

先确定用户指的是哪些真实对象，再执行修改。引用消息是强锚点；“上一条、那个、下午的安排”要结合会话、`memory_search` 和日程快照解析，不能仅靠最近更新时间选中一条。

## 修改前

1. 调用 `calendar_snapshot` 查看受影响范围和现有冲突。
2. 对每个目标调用 `item_get`，确认它是固定事件、截止、提醒还是工作段，并读取完整的现有工作段。
3. 形成整体变更意图。批量移动时先计算所有新位置，再检查它们彼此之间及与未移动安排的冲突；不要边猜边改。

## 选择正确操作

- 移动固定事件：用 `item_update` 修改 `dueAt`，若用户没有改变时长，保持原时长。
- 修改截止：用 `item_update` 改 deadline 的 `dueAt`，不要把预计工作量变成截止后的占用区间。
- 修改提醒：用 `reminder_manage` set/reschedule/cancel。
- 移动、拆分或合并工作段：读取该事项全部工作段后，用 `work_session_manage` replace 一次性写入新的完整计划；取消则用 cancel。
- 完成、舍弃或恢复事项：用 `item_transition`，它会同步清理不再需要的提醒与工作段。

用户给出确切时间时忠实保留。用户给出相对变化或模糊时段时，用 `availability_find` 检查候选，再结合原顺序、原时长、截止和档案选择；不要把“往后推”偷偷改成某个固定取整规则。

批量修改没有人为条数上限。逐项执行后核对工具结果；若部分失败，准确报告哪些已改、哪些没改以及原因，不要把部分成功说成全部完成。

当前内部模型没有重复日程系列对象。遇到“每周、每天”等重复请求时，不要伪造已经建立无限重复；应明确说明这一能力尚未建立，除非用户明确要创建若干个具体实例。
