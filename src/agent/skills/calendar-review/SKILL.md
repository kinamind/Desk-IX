---
name: calendar-review
description: 复盘和重排 Desk-IX 内部日程。每日安排、今日进展、晚间回顾、本周计划、会议结束后的处理、工作段过去后的确认、逾期事项和当天变化后的重新规划，都应激活此技能。
compatibility: Desk-IX internal calendar tools and actions
allowed-tools: calendar_snapshot availability_find memory_search item_get item_update item_transition reminder_manage work_session_manage lifecycle_followup_manage profile_get
---

# 复盘与重排内部日程

复盘不是按时间自动改状态，而是基于最新事实重新判断什么已经发生、什么实现了目标、什么仍需要下一步。

## 获取上下文

用 `calendar_snapshot` 覆盖需要回顾的过去范围和接下来的相关范围；用 `memory_search`、`item_get` 和 `profile_get` 获取事项内容、已有工作段、截止、优先级与个人偏好。区分已经保存的安排和仅准备提出的建议。

## 两个独立判断

- **发生确定性**：这个事件或工作段是否很可能已经发生或结束？
- **结果确定性**：用户的目标是否已经达成，还是仍有产物、答复或后续行动？

固定会议到了结束时间，通常只能提高“事件已经结束”的置信度，不自动证明会议目标完成。高确定性且完成含义清楚时可以更新并告知，允许用户纠正；不确定时保持原状态并询问，或用 `lifecycle_followup_manage` 在更合适的时间再次复盘。后续工作应与已结束事件分开保存和规划。

## 日常与周期计划

把固定事件作为承诺、deadline 作为风险边界、work session 作为已投入计划、reminder 作为通知。检查预计工作量是否在截止前得到足够工作段，发现当天变化或失败的工作段时，重新查询空档并提出或执行用户已授权的调整。

不要用固定数量的 Must/Should 项目截断完整情况，也不要按“会议”“作业”等关键词写死状态转换。回复应优先呈现最值得关注的取舍、冲突、风险和已经执行的调整。
