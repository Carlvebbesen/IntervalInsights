import { and, asc, desc, eq } from "drizzle-orm";
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
