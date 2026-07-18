import { type InferInsertModel, type InferSelectModel, relations } from "drizzle-orm";
import { index, jsonb, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CoachArtifact } from "../schemas/api_schemas";
import { chatMessageStatusEnum, chatRoleEnum } from "./enums";
import { users } from "./users";

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("chat_conversations_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .references(() => chatConversations.id, { onDelete: "cascade" })
      .notNull(),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    status: chatMessageStatusEnum("status"),
    artifacts: jsonb("artifacts").$type<CoachArtifact[]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("chat_messages_conversation_idx").on(table.conversationId, table.createdAt)],
);

export const chatConversationsRelations = relations(chatConversations, ({ one, many }) => ({
  user: one(users, { fields: [chatConversations.userId], references: [users.id] }),
  messages: many(chatMessages),
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  conversation: one(chatConversations, {
    fields: [chatMessages.conversationId],
    references: [chatConversations.id],
  }),
}));

export type InsertChatConversation = InferInsertModel<typeof chatConversations>;
export type SelectChatConversation = InferSelectModel<typeof chatConversations>;
export type InsertChatMessage = InferInsertModel<typeof chatMessages>;
export type SelectChatMessage = InferSelectModel<typeof chatMessages>;
