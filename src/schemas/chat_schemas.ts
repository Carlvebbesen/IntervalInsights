import "zod-openapi/extend";
import { z } from "zod";
import { trainingTypeEnum } from "../schema/enums";
import { ProposedTrainingArtifactSchema } from "./agent_schemas";
import { WeatherSchema } from "./common_schemas";

export const CoachChatRequestSchema = z
  .object({
    conversationId: z
      .string()
      .uuid()
      .describe("Stable id for the conversation thread (persisted)."),
    message: z.string().min(1).max(4000),
    userTime: z.string().describe("Athlete's current local time (ISO 8601)."),
    weather: WeatherSchema.partial().optional(),
  })
  .openapi({ ref: "CoachChatRequest" });

export type CoachChatRequest = z.infer<typeof CoachChatRequestSchema>;

export const ChatConversationSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi({ ref: "ChatConversationSummary" });

export const ChatConversationListSchema = z
  .object({
    data: z.array(ChatConversationSummarySchema),
    meta: z.object({ page: z.number(), pageSize: z.number() }),
  })
  .openapi({ ref: "ChatConversationList" });

export const ChartArtifactSchema = z
  .object({
    type: z.literal("chart"),
    id: z.string(),
    chartType: z.enum(["line", "bar", "area", "scatter"]),
    title: z.string(),
    xLabel: z.string().optional(),
    yLabel: z.string().optional(),
    xType: z.enum(["number", "category", "time"]).optional(),
    series: z.array(
      z.object({
        name: z.string(),
        points: z.array(z.object({ x: z.number(), y: z.number(), label: z.string().optional() })),
      }),
    ),
  })
  .openapi({ ref: "ChartArtifact" });

export const TableArtifactSchema = z
  .object({
    type: z.literal("table"),
    id: z.string(),
    title: z.string().optional(),
    columns: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        align: z.enum(["left", "right", "center"]).optional(),
      }),
    ),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  })
  .openapi({ ref: "TableArtifact" });

export const StatCardsArtifactSchema = z
  .object({
    type: z.literal("stat_cards"),
    id: z.string(),
    title: z.string().optional(),
    cards: z.array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
        unit: z.string().optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
        hint: z.string().optional(),
      }),
    ),
  })
  .openapi({ ref: "StatCardsArtifact" });

export const WeeklyPlanArtifactSchema = z
  .object({
    type: z.literal("weekly_plan"),
    id: z.string(),
    title: z.string(),
    days: z.array(
      z.object({
        day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
        sessionType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
        title: z.string(),
        description: z.string().optional(),
        isRest: z.boolean().optional(),
      }),
    ),
  })
  .openapi({ ref: "WeeklyPlanArtifact" });

export const CoachArtifactSchema = z
  .discriminatedUnion("type", [
    ProposedTrainingArtifactSchema,
    ChartArtifactSchema,
    TableArtifactSchema,
    StatCardsArtifactSchema,
    WeeklyPlanArtifactSchema,
  ])
  .openapi({ ref: "CoachArtifact" });

export type CoachArtifact = z.infer<typeof CoachArtifactSchema>;

export const ChatMessageSchema = z
  .object({
    id: z.number(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    status: z.enum(["interrupted", "error"]).nullish(),
    artifacts: z.array(CoachArtifactSchema).nullish(),
    createdAt: z.string(),
  })
  .openapi({ ref: "ChatMessage" });

export const ChatConversationDetailSchema = ChatConversationSummarySchema.extend({
  messages: z.array(ChatMessageSchema),
  meta: z.object({
    hasMore: z.boolean(),
    nextBefore: z.number().nullable(),
  }),
}).openapi({ ref: "ChatConversationDetail" });

export const RenameConversationSchema = z
  .object({ title: z.string().trim().min(1).max(120) })
  .openapi({ ref: "RenameConversation" });

export const ChatDeleteResponseSchema = z
  .object({ success: z.boolean() })
  .openapi({ ref: "ChatDeleteResponse" });
