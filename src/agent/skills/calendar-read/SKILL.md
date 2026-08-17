---
name: calendar-read
description: 读取和解释 Desk-IX 内部日程。用户询问今天、明天、本周、某个时间段有什么安排，何时有空、是否冲突、某个截止或提醒在什么时候，或需要综合查看事件、截止、工作段和提醒时，都应激活此技能，即使用户没有说“日历”。
compatibility: Desk-IX internal calendar tools
allowed-tools: calendar_snapshot availability_find memory_search item_get profile_get
---

# 读取内部日程

先把用户的问题转换成其时区下明确的半开时间范围，再调用 `calendar_snapshot` 获取事实。不要凭对话记忆重建日程；对某条记录的正文、来源或状态有疑问时，再用 `memory_search` 和 `item_get` 补充。

## 理解四类时间对象

- `event` 是固定发生的事件，从 `startAt` 到 `endAt` 占用时间。
- `deadline` 是最晚完成时刻，可见但不占用时间；预计工作量不是从截止时刻开始的一段会议。
- `work_session` 是已经计划投入工作的时段，会占用时间。
- `reminder` 是通知点，可用于观察提醒密度，但不占用一段工作时间。

`temporalRole=legacy` 表示旧记录仍按事件显示。若用户要修改它，先结合原文判断真正语义，再通过 `item_update` 校正；不要仅凭标题猜。

## 回答方式

按用户真正关心的粒度组织，不强制套固定日报格式。清楚区分：

- 已经确定或保存的安排；
- 仅有截止但尚未安排投入时间的事项；
- 只是提醒的通知；
- 你准备提出、但尚未写入的建议。

报告 `calendar_snapshot` 返回的真实冲突。用户问“什么时候有空”或需要满足某个时长时，调用 `availability_find`；它返回所有合格空档，你再结合档案、语境和目标判断哪些值得推荐。不要把空档列表本身说成已经安排。

没有条目时直接说明该范围内内部日程为空，不要据此断言用户现实中没有其他安排。
