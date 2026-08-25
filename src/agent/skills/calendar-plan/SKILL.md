---
name: calendar-plan
description: 为任务和目标制定可执行的内部日程。用户要求安排今天或本周、把一项工作放到下午或晚上、在截止前拆分完成、寻找合适时间、调整工作量，或希望 Desk-IX 自主规划时间时，都应激活此技能。
compatibility: Desk-IX internal calendar tools and actions
allowed-tools: calendar_snapshot availability_find profile_get memory_search item_get item_create item_update reminder_manage work_session_manage lifecycle_followup_manage
---

# 规划内部日程

规划的目标不是把待办机械地铺进日历，而是给真正需要推进的事情安排可执行投入，同时保留用户的选择空间。

## 建立事实基础

1. 用 `memory_search` 和 `item_get` 确认目标事项、截止时间、`startAfter`、预计工作量和已有工作段。
2. 用 `profile_get` 读取时区、作息倾向和已明确偏好。
3. 用 `calendar_snapshot` 查看足以覆盖相关截止的范围；需要某种连续时长时，再用 `availability_find` 获取全部可用区间。
4. 同时考虑固定事件、已有工作段、提醒密度、其他截止和当前本地时间。

## 形成计划

- `deadline` 只表示最晚完成时间；真正投入用 `work_session_manage` 保存。
- `event` 是固定发生的安排。创建时将 `dueAt` 作为开始、`estimatedDuration` 作为持续时间。
- `reminder` 只是促成下一步的通知，不代替工作段。
- `startAfter` 只是最早可开始时间，不代表已有预订。

由任务本身、剩余时间、认知负荷、用户作息和空档共同决定是否拆分、拆成几段、每段多长。不要使用固定钟点、固定番茄钟、固定晚间模板或按事项类别套时长。若预计工作量明显无法在截止前放入，明确指出取舍或风险，不要假装计划可行。

对模糊时段，你选择的具体时间属于 `agent_selected`。用户亲自给出具体钟点才属于 `user_exact`；只有用户知情接受明确冲突时才使用 `allowConflict`。

写入后准确交接本轮实际保存的工作段、提醒、关键取舍和可修改之处。不要顺带复述与本轮计划无关的旧任务；建议但未执行的内容要明确标成建议，最终展示范围由前台注意力层结合用户当下意图决定。
