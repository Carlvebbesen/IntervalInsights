import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { type ChatMessageStatus, type ChatRole, chatConversations, chatMessages } from "../schema";
import type { CoachArtifact } from "../schemas/api_schemas";
import type { IGlobalBindings } from "../types/IRouters";

type Db = IGlobalBindings["db"];

export const CONVERSATIONS_PAGE_SIZE = 20;

export async function ensureConversation(
  db: Db,
  userId: string,
  conversationId: string,
  title: string,
): Promise<boolean> {
  const existing = await db.query.chatConversations.findFirst({
    where: eq(chatConversations.id, conversationId),
    columns: { userId: true },
  });

  if (existing) return existing.userId === userId;

  const inserted = await db
    .insert(chatConversations)
    .values({ id: conversationId, userId, title })
    .onConflictDoNothing()
    .returning({ id: chatConversations.id });
  if (inserted.length > 0) return true;

  const raced = await db.query.chatConversations.findFirst({
    where: eq(chatConversations.id, conversationId),
    columns: { userId: true },
  });
  return raced?.userId === userId;
}

export async function insertMessage(
  db: Db,
  conversationId: string,
  role: ChatRole,
  content: string,
  artifacts?: CoachArtifact[] | null,
  status?: ChatMessageStatus | null,
): Promise<{ id: number; createdAt: Date }> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      conversationId,
      role,
      content,
      status: status ?? null,
      artifacts: artifacts?.length ? artifacts : null,
    })
    .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  return row;
}

export async function touchConversation(db: Db, conversationId: string): Promise<void> {
  await db
    .update(chatConversations)
    .set({ updatedAt: new Date() })
    .where(eq(chatConversations.id, conversationId));
}

export async function countCleanAssistantMessages(db: Db, conversationId: string): Promise<number> {
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "assistant"),
        isNull(chatMessages.status),
      ),
    );
  return rows.length;
}

export async function updateConversationTitle(
  db: Db,
  conversationId: string,
  title: string,
): Promise<void> {
  await db.update(chatConversations).set({ title }).where(eq(chatConversations.id, conversationId));
}

export async function renameConversation(db: Db, conversationId: string, title: string) {
  const [row] = await db
    .update(chatConversations)
    .set({ title })
    .where(eq(chatConversations.id, conversationId))
    .returning({
      id: chatConversations.id,
      title: chatConversations.title,
      createdAt: chatConversations.createdAt,
      updatedAt: chatConversations.updatedAt,
    });
  return row;
}

export async function deleteConversation(db: Db, conversationId: string): Promise<void> {
  await db.delete(chatConversations).where(eq(chatConversations.id, conversationId));
}

export function listConversationsForUser(db: Db, userId: string, page: number) {
  return db
    .select({
      id: chatConversations.id,
      title: chatConversations.title,
      createdAt: chatConversations.createdAt,
      updatedAt: chatConversations.updatedAt,
    })
    .from(chatConversations)
    .where(eq(chatConversations.userId, userId))
    .orderBy(desc(chatConversations.updatedAt))
    .limit(CONVERSATIONS_PAGE_SIZE)
    .offset((page - 1) * CONVERSATIONS_PAGE_SIZE);
}

export function getConversationForUser(db: Db, userId: string, conversationId: string) {
  return db.query.chatConversations.findFirst({
    where: and(eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId)),
  });
}

export function listMessages(db: Db, conversationId: string) {
  return db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      status: chatMessages.status,
      artifacts: chatMessages.artifacts,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
}

export type MessagesPage = {
  messages: Awaited<ReturnType<typeof listMessages>>;
  hasMore: boolean;
  nextBefore: number | null;
};

// Returns a window of at most `limit` messages in ascending order. Without a
// cursor the window is the newest `limit`; with `before` it is the newest
// `limit` strictly older than that message id. `hasMore`/`nextBefore` page
// further back in time (feed `nextBefore` as the next `before`).
export async function listMessagesPage(
  db: Db,
  conversationId: string,
  limit: number,
  before?: number,
): Promise<MessagesPage> {
  const where =
    before === undefined
      ? eq(chatMessages.conversationId, conversationId)
      : and(eq(chatMessages.conversationId, conversationId), lt(chatMessages.id, before));

  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      status: chatMessages.status,
      artifacts: chatMessages.artifacts,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(where)
    .orderBy(desc(chatMessages.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore ? pageRows[pageRows.length - 1].id : null;
  pageRows.reverse();
  return { messages: pageRows, hasMore, nextBefore };
}
