CREATE TYPE "public"."chat_message_status" AS ENUM('interrupted', 'error');--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "status" "chat_message_status";