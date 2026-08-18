import type {
  ChannelName,
  ContextEntity,
  ContextEntityKind,
  ContextFact,
  ContextParticipant,
} from "../core/types";
import { getOwnedItem } from "./items";

export interface ContextOwner {
  channel: ChannelName;
  userId: string;
}

export interface RememberEntityInput {
  key: string;
  kind: Exclude<ContextEntityKind, "self">;
  name: string;
  aliases?: string[] | undefined;
  summary?: string | null | undefined;
}

export interface RememberFactInput {
  subject: string;
  predicate: string;
  value: string;
  object?: string | undefined;
  contextItemId?: string | null | undefined;
  confidence?: number | undefined;
  sensitivity?: "ordinary" | "sensitive" | undefined;
  validFrom?: string | null | undefined;
  validUntil?: string | null | undefined;
}

export interface RememberItemLinkInput {
  itemId: string;
  entity: string;
  role: string;
  confidence?: number | undefined;
}

export interface RememberContextInput {
  actionIndex?: number | undefined;
  entities?: RememberEntityInput[] | undefined;
  facts?: RememberFactInput[] | undefined;
  itemLinks?: RememberItemLinkInput[] | undefined;
}

interface EntityRow {
  id: string;
  kind: ContextEntityKind;
  canonical_name: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

interface FactRow {
  id: string;
  subject_entity_id: string;
  predicate: string;
  value: string;
  object_entity_id: string | null;
  context_item_id: string | null;
  confidence: number;
  sensitivity: "ordinary" | "sensitive";
  source_message_id: string;
  valid_from: string | null;
  valid_until: string | null;
  status: ContextFact["status"];
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  item_id: string;
  entity_id: string;
  kind: ContextEntityKind;
  canonical_name: string;
  role: string;
  confidence: number;
}

export interface ContextSearchResult {
  entities: Array<ContextEntity & { facts: ContextFact[]; linkedItems: Array<{ itemId: string; title: string; role: string }> }>;
}

export async function rememberContext(
  db: D1Database,
  owner: ContextOwner,
  input: RememberContextInput,
  sourceMessageId: string,
  now = new Date(),
): Promise<{ entities: Record<string, ContextEntity>; factIds: string[]; linkedItems: number }> {
  const entities = input.entities ?? [];
  const facts = input.facts ?? [];
  const itemLinks = input.itemLinks ?? [];
  const keys = new Set<string>();
  for (const entity of entities) {
    const key = normalizeKey(entity.key);
    if (!key || key === "self" || keys.has(key)) throw new Error("Context entity keys must be unique and cannot use self");
    keys.add(key);
  }
  const declaredKeys = new Map(entities.map((entity) => [normalizeKey(entity.key), entity]));
  for (const fact of facts) {
    assertReference(fact.subject, declaredKeys);
    if (fact.object) assertReference(fact.object, declaredKeys);
    assertConfidence(fact.confidence ?? 0.8);
    assertValidity(fact.validFrom ?? null, fact.validUntil ?? null);
    if (fact.contextItemId) await assertOwnedItem(db, owner, fact.contextItemId);
  }
  for (const link of itemLinks) {
    assertReference(link.entity, declaredKeys, false);
    assertConfidence(link.confidence ?? 1);
    await assertOwnedItem(db, owner, link.itemId);
  }

  const timestamp = now.toISOString();
  const resolved = new Map<string, ContextEntity>();
  if (facts.some((fact) => normalizeKey(fact.subject) === "self" || normalizeKey(fact.object ?? "") === "self")) {
    resolved.set("self", await upsertEntity(db, owner, {
      kind: "self",
      name: "self",
      aliases: [],
      summary: null,
    }, timestamp));
  }
  for (const entity of entities) {
    resolved.set(normalizeKey(entity.key), await upsertEntity(db, owner, entity, timestamp));
  }

  const factIds: string[] = [];
  const actionIndex = input.actionIndex ?? 0;
  for (const [index, fact] of facts.entries()) {
    const subject = resolved.get(normalizeKey(fact.subject));
    const object = fact.object ? resolved.get(normalizeKey(fact.object)) : null;
    if (!subject || (fact.object && !object)) throw new Error("Context fact references an unresolved entity");
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO context_facts (
        id, owner_channel, owner_user_id, subject_entity_id, predicate, value,
        object_entity_id, context_item_id, confidence, sensitivity,
        source_message_id, source_action_index, source_fact_index,
        valid_from, valid_until, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(owner_channel, owner_user_id, source_message_id, source_action_index, source_fact_index)
      DO NOTHING
    `).bind(
      id,
      owner.channel,
      owner.userId,
      subject.id,
      cleanText(fact.predicate, 100),
      cleanText(fact.value, 2_000),
      object?.id ?? null,
      fact.contextItemId ?? null,
      fact.confidence ?? 0.8,
      fact.sensitivity ?? "ordinary",
      sourceMessageId,
      actionIndex,
      index,
      fact.validFrom ?? null,
      fact.validUntil ?? null,
      timestamp,
      timestamp,
    ).run();
    const stored = await db.prepare(`
      SELECT id FROM context_facts
      WHERE owner_channel = ? AND owner_user_id = ? AND source_message_id = ?
        AND source_action_index = ? AND source_fact_index = ?
    `).bind(owner.channel, owner.userId, sourceMessageId, actionIndex, index).first<{ id: string }>();
    if (!stored) throw new Error("Context fact insert did not return a row");
    factIds.push(stored.id);
  }

  for (const link of itemLinks) {
    const entity = resolved.get(normalizeKey(link.entity));
    if (!entity) throw new Error("Context item link references an unresolved entity");
    await db.prepare(`
      INSERT INTO item_context_entities (
        item_id, entity_id, role, confidence, source_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, entity_id, role) DO UPDATE SET
        confidence = excluded.confidence,
        source_message_id = excluded.source_message_id,
        updated_at = excluded.updated_at
    `).bind(
      link.itemId,
      entity.id,
      cleanText(link.role, 100),
      link.confidence ?? 1,
      sourceMessageId,
      timestamp,
      timestamp,
    ).run();
  }

  return { entities: Object.fromEntries(resolved), factIds, linkedItems: itemLinks.length };
}

export async function searchOwnedContext(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  query: string,
  now = new Date(),
): Promise<ContextSearchResult> {
  const normalizedQuery = normalizeName(query);
  if (!normalizedQuery) return { entities: [] };
  const result = await db.prepare(`
    SELECT DISTINCT e.*
    FROM context_entities e
    LEFT JOIN context_entity_aliases a ON a.entity_id = e.id
    LEFT JOIN context_facts f ON f.subject_entity_id = e.id AND f.status = 'active'
    WHERE e.owner_channel = ? AND e.owner_user_id = ?
      AND (
        instr(?, e.normalized_name) > 0
        OR instr(?, a.normalized_alias) > 0
        OR (
          f.id IS NOT NULL
          AND (
            instr(lower(?), lower(f.predicate)) > 0
            OR instr(lower(?), lower(f.value)) > 0
          )
        )
      )
    ORDER BY e.updated_at DESC
  `).bind(channel, userId, normalizedQuery, normalizedQuery, query.trim(), query.trim()).all<EntityRow>();
  const entities = await Promise.all(result.results.map(async (row) => {
    const [entity, facts, linkedItems] = await Promise.all([
      mapEntityWithAliases(db, row),
      listEntityFacts(db, channel, userId, row.id, now),
      db.prepare(`
        SELECT i.id AS item_id, i.title, ice.role
        FROM item_context_entities ice JOIN items i ON i.id = ice.item_id
        WHERE ice.entity_id = ? AND i.source_channel = ? AND i.source_user_id = ?
        ORDER BY i.updated_at DESC
      `).bind(row.id, channel, userId).all<{ item_id: string; title: string; role: string }>(),
    ]);
    return {
      ...entity,
      facts,
      linkedItems: linkedItems.results.map((item) => ({ itemId: item.item_id, title: item.title, role: item.role })),
    };
  }));
  return { entities };
}

export async function listOwnedSelfFacts(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  now = new Date(),
): Promise<ContextFact[]> {
  const self = await db.prepare(`
    SELECT * FROM context_entities
    WHERE owner_channel = ? AND owner_user_id = ? AND kind = 'self'
    LIMIT 1
  `).bind(channel, userId).first<EntityRow>();
  return self ? listEntityFacts(db, channel, userId, self.id, now) : [];
}

export async function listOwnedItemParticipants(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  itemIds: string[],
): Promise<Map<string, ContextParticipant[]>> {
  const uniqueIds = Array.from(new Set(itemIds));
  const participants = new Map<string, ContextParticipant[]>();
  if (uniqueIds.length === 0) return participants;
  const rows = await db.prepare(`
    SELECT ice.item_id, e.id AS entity_id, e.kind, e.canonical_name, ice.role, ice.confidence
    FROM item_context_entities ice
    JOIN context_entities e ON e.id = ice.entity_id
    JOIN items i ON i.id = ice.item_id
    WHERE ice.item_id IN (${uniqueIds.map(() => "?").join(", ")})
      AND e.owner_channel = ? AND e.owner_user_id = ?
      AND i.source_channel = ? AND i.source_user_id = ?
    ORDER BY e.canonical_name ASC
  `).bind(...uniqueIds, channel, userId, channel, userId).all<ParticipantRow>();
  for (const row of rows.results) {
    const current = participants.get(row.item_id) ?? [];
    current.push({
      entityId: row.entity_id,
      kind: row.kind,
      name: row.canonical_name,
      role: row.role,
      confidence: row.confidence,
    });
    participants.set(row.item_id, current);
  }
  return participants;
}

export async function retractOwnedContext(
  db: D1Database,
  owner: ContextOwner,
  input: { factIds?: string[]; entityIds?: string[] },
  now = new Date(),
): Promise<{ retractedFacts: number; deletedEntities: number }> {
  const timestamp = now.toISOString();
  let retractedFacts = 0;
  let deletedEntities = 0;
  for (const factId of Array.from(new Set(input.factIds ?? []))) {
    const result = await db.prepare(`
      UPDATE context_facts SET status = 'retracted', updated_at = ?
      WHERE id = ? AND owner_channel = ? AND owner_user_id = ? AND status = 'active'
    `).bind(timestamp, factId, owner.channel, owner.userId).run();
    retractedFacts += result.meta.changes ?? 0;
  }
  for (const entityId of Array.from(new Set(input.entityIds ?? []))) {
    const result = await db.prepare(`
      DELETE FROM context_entities
      WHERE id = ? AND owner_channel = ? AND owner_user_id = ? AND kind != 'self'
    `).bind(entityId, owner.channel, owner.userId).run();
    deletedEntities += result.meta.changes ?? 0;
  }
  return { retractedFacts, deletedEntities };
}

async function upsertEntity(
  db: D1Database,
  owner: ContextOwner,
  input: Pick<RememberEntityInput, "kind" | "name" | "aliases" | "summary"> | {
    kind: "self";
    name: "self";
    aliases: [];
    summary: null;
  },
  timestamp: string,
): Promise<ContextEntity> {
  const name = cleanText(input.name, 200);
  const normalized = normalizeName(name);
  if (!normalized) throw new Error("Context entity name is empty after normalization");
  const existing = await db.prepare(`
    SELECT * FROM context_entities
    WHERE owner_channel = ? AND owner_user_id = ? AND kind = ? AND normalized_name = ?
    LIMIT 1
  `).bind(owner.channel, owner.userId, input.kind, normalized).first<EntityRow>();
  const id = existing?.id ?? crypto.randomUUID();
  if (existing) {
    await db.prepare(`
      UPDATE context_entities
      SET canonical_name = ?, summary = COALESCE(?, summary), updated_at = ?, last_seen_at = ?
      WHERE id = ?
    `).bind(name, input.summary ?? null, timestamp, timestamp, id).run();
  } else {
    await db.prepare(`
      INSERT INTO context_entities (
        id, owner_channel, owner_user_id, kind, canonical_name, normalized_name,
        summary, created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      owner.channel,
      owner.userId,
      input.kind,
      name,
      normalized,
      input.summary ?? null,
      timestamp,
      timestamp,
      timestamp,
    ).run();
  }
  for (const alias of Array.from(new Set([name, ...(input.aliases ?? [])]))) {
    const cleanAlias = cleanText(alias, 200);
    const normalizedAlias = normalizeName(cleanAlias);
    if (!normalizedAlias) continue;
    await db.prepare(`
      INSERT OR IGNORE INTO context_entity_aliases (entity_id, alias, normalized_alias, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(id, cleanAlias, normalizedAlias, timestamp).run();
  }
  const row = await db.prepare("SELECT * FROM context_entities WHERE id = ?").bind(id).first<EntityRow>();
  if (!row) throw new Error("Context entity insert did not return a row");
  return mapEntityWithAliases(db, row);
}

async function mapEntityWithAliases(db: D1Database, row: EntityRow): Promise<ContextEntity> {
  const aliases = await db.prepare(`
    SELECT alias FROM context_entity_aliases WHERE entity_id = ? ORDER BY alias ASC
  `).bind(row.id).all<{ alias: string }>();
  return {
    id: row.id,
    kind: row.kind,
    name: row.canonical_name,
    aliases: aliases.results.map((entry) => entry.alias),
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function listEntityFacts(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  entityId: string,
  now: Date,
): Promise<ContextFact[]> {
  const timestamp = now.toISOString();
  const facts = await db.prepare(`
    SELECT * FROM context_facts
    WHERE owner_channel = ? AND owner_user_id = ? AND subject_entity_id = ?
      AND status = 'active'
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_until IS NULL OR valid_until > ?)
    ORDER BY confidence DESC, updated_at DESC
  `).bind(channel, userId, entityId, timestamp, timestamp).all<FactRow>();
  return facts.results.map(mapFact);
}

function mapFact(row: FactRow): ContextFact {
  return {
    id: row.id,
    subjectEntityId: row.subject_entity_id,
    predicate: row.predicate,
    value: row.value,
    objectEntityId: row.object_entity_id,
    contextItemId: row.context_item_id,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    sourceMessageId: row.source_message_id,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKC").replace(/[\p{P}\p{S}\p{Z}\p{Cc}]+/gu, "");
}

function cleanText(value: string, maxLength: number): string {
  const cleaned = value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) throw new Error("Context text cannot be empty");
  return cleaned.slice(0, maxLength);
}

function assertReference(
  value: string,
  declared: Map<string, RememberEntityInput>,
  allowSelf = true,
): void {
  const key = normalizeKey(value);
  if ((allowSelf && key === "self") || declared.has(key)) return;
  throw new Error(`Unknown context entity key: ${value}`);
}

function assertConfidence(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Context confidence must be between 0 and 1");
}

function assertValidity(validFrom: string | null, validUntil: string | null): void {
  const from = validFrom ? new Date(validFrom).getTime() : null;
  const until = validUntil ? new Date(validUntil).getTime() : null;
  if (from !== null && !Number.isFinite(from)) throw new Error("Invalid context validFrom");
  if (until !== null && !Number.isFinite(until)) throw new Error("Invalid context validUntil");
  if (from !== null && until !== null && until <= from) throw new Error("Context validUntil must be after validFrom");
}

async function assertOwnedItem(db: D1Database, owner: ContextOwner, itemId: string): Promise<void> {
  if (!await getOwnedItem(db, itemId, owner.channel, owner.userId)) {
    throw new Error("Context item does not belong to the current user");
  }
}
