export const ITEM_TYPES = ["resource", "idea", "task", "note", "project"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type ChannelName = "telegram" | "qq";
export type MessageIntent = "create_item" | "query" | "analyze" | "help" | "clarify" | "unavailable";

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
  sourceChannel: ChannelName;
  sourceUserId: string;
  sourceMessageId: string;
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
  sourceChannel: ChannelName;
  sourceUserId: string;
  sourceMessageId: string;
  aiEnrichment?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  parentId?: string | null;
}

export interface ItemSearchFilters {
  type?: ItemType;
  statuses?: string[];
  dueFrom?: string;
  dueTo?: string;
  createdFrom?: string;
  keyword?: string;
  limit?: number;
}

export interface ParsedIntent {
  intent: MessageIntent;
  type?: ItemType;
  title?: string;
  content?: string;
  url?: string | null;
  tags?: string[];
  status?: string;
  priority?: Priority;
  estimatedDuration?: number | null;
  dueAt?: string | null;
  reminderAt?: string | null;
  startAfter?: string | null;
  originalTimeExpression?: string | null;
  query?: ItemSearchFilters;
  question?: string;
  confidence: number;
  source: "system" | "ai";
  aiEnrichment?: Record<string, unknown>;
}

export interface CallbackAction {
  name: "done" | "later" | "reschedule" | "details";
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
