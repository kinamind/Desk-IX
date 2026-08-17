export const ITEM_TYPES = ["resource", "idea", "task", "note", "project"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type ChannelName = "telegram" | "qq";

export const TEMPORAL_ROLES = ["none", "deadline", "event", "legacy"] as const;
export type TemporalRole = (typeof TEMPORAL_ROLES)[number];

export const CHRONOTYPES = ["unknown", "early", "balanced", "late"] as const;
export type Chronotype = (typeof CHRONOTYPES)[number];
export type UserPreferenceValue = string | number | boolean | null | string[];

export interface UserProfile {
  channel: ChannelName;
  userId: string;
  userCallName: string | null;
  assistantCallName: string;
  timezone: string;
  locale: string;
  dailyPlanEnabled: boolean;
  dailyPlanTime: string;
  chronotype: Chronotype;
  targetWakeTime: string | null;
  targetSleepTime: string | null;
  routineCoaching: boolean;
  communicationStyle: string;
  preferences: Record<string, UserPreferenceValue>;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileDefaults {
  timezone: string;
  locale: string;
  dailyPlanTime: string;
}

export interface UserProfileUpdate {
  userCallName?: string | null;
  assistantCallName?: string;
  timezone?: string;
  locale?: string;
  dailyPlanEnabled?: boolean;
  dailyPlanTime?: string;
  chronotype?: Chronotype;
  targetWakeTime?: string | null;
  targetSleepTime?: string | null;
  routineCoaching?: boolean;
  communicationStyle?: string;
  preferences?: Record<string, UserPreferenceValue>;
}

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  content: string;
  rawMessage: string;
  url: string | null;
  tags: string[];
  status: string;
  priority: Priority;
  estimatedDuration: number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  dueAt: string | null;
  startAfter: string | null;
  originalTimeExpression: string | null;
  temporalRole: TemporalRole;
  sourceChannel: ChannelName;
  sourceUserId: string;
  sourceMessageId: string;
  sourceActionIndex: number;
  aiEnrichment: Record<string, unknown>;
  metadata: Record<string, unknown>;
  parentId: string | null;
  embeddingId: string | null;
}

export interface CreateItemInput {
  type: ItemType;
  title: string;
  content: string;
  rawMessage: string;
  url?: string | null;
  tags?: string[];
  status?: string;
  priority?: Priority;
  estimatedDuration?: number | null;
  dueAt?: string | null;
  startAfter?: string | null;
  originalTimeExpression?: string | null;
  temporalRole?: TemporalRole;
  sourceChannel: ChannelName;
  sourceUserId: string;
  sourceMessageId: string;
  sourceActionIndex?: number;
  aiEnrichment?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
}

export interface UpdateItemInput {
  title?: string;
  content?: string;
  tags?: string[];
  priority?: Priority;
  estimatedDuration?: number | null;
  dueAt?: string | null;
  startAfter?: string | null;
  originalTimeExpression?: string | null;
  temporalRole?: TemporalRole;
}

export interface ItemSearchFilters {
  type?: ItemType;
  statuses?: string[];
  dueFrom?: string;
  dueTo?: string;
  createdFrom?: string;
  keyword?: string;
  limit?: number | null;
}

export interface ScheduleWindow {
  itemId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  source: "item" | "reminder" | "message" | "work_session";
}

export interface WorkSession {
  id: string;
  itemId: string;
  startAt: string;
  endAt: string;
  label: string | null;
  rationale: string;
  status: "planned" | "completed" | "canceled";
  createdAt: string;
  updatedAt: string;
}


export interface CallbackAction {
  name: "done" | "archive" | "restore" | "later" | "reschedule" | "details";
  itemId: string;
  value?: string;
  interactionId?: string;
}

export interface IncomingMessage {
  channel: ChannelName;
  eventId: string;
  messageId: string;
  userId: string;
  text: string;
  timestamp: string;
  eventType: "message" | "callback";
  callback?: CallbackAction;
  replyToMessageId?: string;
}

export interface OutgoingButton {
  label: string;
  action: string;
  style?: "default" | "primary" | "danger";
}

export interface OutgoingMessage {
  text: string;
  buttons?: OutgoingButton[][];
  replyToMessageId?: string;
}

export interface ChannelTarget {
  channel: ChannelName;
  userId: string;
}

export interface DeliveryReceipt {
  channel: ChannelName;
  messageId: string;
  deliveredAt: string;
}

export interface Reminder {
  id: string;
  itemId: string;
  remindAt: string;
  status: "pending" | "delivering" | "triggered" | "canceled" | "failed";
  kind: string;
  targetChannel: ChannelName;
  targetUserId: string;
  workflowId: string | null;
  createdAt: string;
  triggeredAt: string | null;
}

export interface ReminderWorkflowPayload {
  reminderId: string;
  remindAt: string;
}
