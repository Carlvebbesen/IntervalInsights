import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as trainingPlanController from "../controllers/training_plan_controller";
import {
  plannedSessionStatusEnum,
  planWeekPhaseEnum,
  trainingPlanStatusEnum,
  trainingTypeEnum,
} from "../schema";
import { WorkoutStructureSetSchema } from "../schemas/agent_schemas";
import {
  DeleteTrainingPlanResponseSchema,
  ErrorSchema,
  PlannedSessionSchema,
  TrainingPlanDetailSchema,
  TrainingPlanListResponseSchema,
  TrainingPlanSchema,
  TrainingPlanWeekSchema,
} from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const trainingPlansRouter = new Hono<TGlobalEnv>();

function atLeastOneField(data: Record<string, unknown>) {
  return Object.values(data).some((v) => v !== undefined);
}

const listQuerySchema = z.object({
  status: z.enum(trainingPlanStatusEnum.enumValues).optional(),
});

trainingPlansRouter.get(
  "/",
  describeRoute({
    description: "List training plans for the authenticated user, newest first.",
    responses: {
      200: {
        description: "Training plans",
        content: { "application/json": { schema: resolver(TrainingPlanListResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", listQuerySchema),
  async (c) => {
    const data = await trainingPlanController.listTrainingPlans(
      c.env.db,
      c.get("userId"),
      c.req.valid("query"),
    );
    return c.json({ data });
  },
);

const createSessionSchema = z.object({
  date: z.string().date(),
  sessionType: z.enum(trainingTypeEnum.enumValues),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  structure: z.array(WorkoutStructureSetSchema).optional(),
  sortOrder: z.number().int().optional(),
});

const createWeekSchema = z.object({
  weekIndex: z.number().int().nonnegative(),
  startDate: z.string().date(),
  phase: z.enum(planWeekPhaseEnum.enumValues).optional(),
  targetDistanceMeters: z.number().int().positive().optional(),
  targetLoad: z.number().int().positive().optional(),
  notes: z.string().min(1).optional(),
  sessions: z.array(createSessionSchema).optional(),
});

const createTrainingPlanSchema = z
  .object({
    name: z.string().min(1),
    startDate: z.string().date(),
    endDate: z.string().date(),
    raceEventId: z.number().int().positive().optional(),
    goalText: z.string().min(1).optional(),
    status: z.enum(trainingPlanStatusEnum.enumValues).optional(),
    weeks: z.array(createWeekSchema).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.weeks) return;
    const seen = new Set<number>();
    data.weeks.forEach((week, index) => {
      if (seen.has(week.weekIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Duplicate weekIndex values are not allowed within a plan",
          path: ["weeks", index, "weekIndex"],
        });
      }
      seen.add(week.weekIndex);
    });
  });

trainingPlansRouter.post(
  "/",
  describeRoute({
    description:
      "Create a training plan, optionally with nested weeks and sessions in a single call.",
    responses: {
      201: {
        description: "Created training plan with its full week/session tree",
        content: { "application/json": { schema: resolver(TrainingPlanDetailSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Race event not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", createTrainingPlanSchema),
  async (c) => {
    const created = await trainingPlanController.createTrainingPlan(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json(created, 201);
  },
);

const planIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

trainingPlansRouter.get(
  "/:id",
  describeRoute({
    description: "Get a training plan's full detail: the plan, its weeks, and their sessions.",
    responses: {
      200: {
        description: "Training plan detail",
        content: { "application/json": { schema: resolver(TrainingPlanDetailSchema) } },
      },
      404: {
        description: "Training plan not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", planIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const detail = await trainingPlanController.getTrainingPlan(c.env.db, c.get("userId"), id);
    return c.json(detail);
  },
);

const updateTrainingPlanSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(trainingPlanStatusEnum.enumValues).optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
    raceEventId: z.number().int().positive().nullable().optional(),
    goalText: z.string().min(1).nullable().optional(),
  })
  .refine(atLeastOneField, { message: "At least one field must be provided" });

trainingPlansRouter.patch(
  "/:id",
  describeRoute({
    description: "Edit a training plan's top-level fields.",
    responses: {
      200: {
        description: "Updated training plan",
        content: { "application/json": { schema: resolver(TrainingPlanSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Training plan or race event not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", planIdParamSchema),
  validator("json", updateTrainingPlanSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const updated = await trainingPlanController.updateTrainingPlan(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(updated);
  },
);

trainingPlansRouter.delete(
  "/:id",
  describeRoute({
    description: "Delete a training plan. Cascades to its weeks and sessions.",
    responses: {
      200: {
        description: "Delete result",
        content: { "application/json": { schema: resolver(DeleteTrainingPlanResponseSchema) } },
      },
      404: {
        description: "Training plan not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", planIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const result = await trainingPlanController.deleteTrainingPlan(c.env.db, c.get("userId"), id);
    return c.json(result);
  },
);

const addWeekSchema = z.object({
  weekIndex: z.number().int().nonnegative(),
  startDate: z.string().date(),
  phase: z.enum(planWeekPhaseEnum.enumValues).optional(),
  targetDistanceMeters: z.number().int().positive().optional(),
  targetLoad: z.number().int().positive().optional(),
  notes: z.string().min(1).optional(),
});

trainingPlansRouter.post(
  "/:id/weeks",
  describeRoute({
    description: "Add a week to a training plan.",
    responses: {
      201: {
        description: "Created week",
        content: { "application/json": { schema: resolver(TrainingPlanWeekSchema) } },
      },
      404: {
        description: "Training plan not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      409: {
        description: "A week with this index already exists in the plan",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", planIdParamSchema),
  validator("json", addWeekSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const week = await trainingPlanController.addWeek(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(week, 201);
  },
);

const weekParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  weekId: z.coerce.number().int().positive(),
});

const updateWeekSchema = z
  .object({
    weekIndex: z.number().int().nonnegative().optional(),
    startDate: z.string().date().optional(),
    phase: z.enum(planWeekPhaseEnum.enumValues).nullable().optional(),
    targetDistanceMeters: z.number().int().positive().nullable().optional(),
    targetLoad: z.number().int().positive().nullable().optional(),
    notes: z.string().min(1).nullable().optional(),
  })
  .refine(atLeastOneField, { message: "At least one field must be provided" });

trainingPlansRouter.patch(
  "/:id/weeks/:weekId",
  describeRoute({
    description: "Edit a week belonging to a training plan.",
    responses: {
      200: {
        description: "Updated week",
        content: { "application/json": { schema: resolver(TrainingPlanWeekSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Training plan or week not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      409: {
        description: "A week with this index already exists in the plan",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", weekParamSchema),
  validator("json", updateWeekSchema),
  async (c) => {
    const { id, weekId } = c.req.valid("param");
    const week = await trainingPlanController.updateWeek(
      c.env.db,
      c.get("userId"),
      id,
      weekId,
      c.req.valid("json"),
    );
    return c.json(week);
  },
);

trainingPlansRouter.delete(
  "/:id/weeks/:weekId",
  describeRoute({
    description: "Delete a week from a training plan. Cascades to its sessions.",
    responses: {
      200: {
        description: "Delete result",
        content: { "application/json": { schema: resolver(DeleteTrainingPlanResponseSchema) } },
      },
      404: {
        description: "Training plan or week not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", weekParamSchema),
  async (c) => {
    const { id, weekId } = c.req.valid("param");
    const result = await trainingPlanController.deleteWeek(c.env.db, c.get("userId"), id, weekId);
    return c.json(result);
  },
);

const addSessionSchema = z.object({
  weekId: z.number().int().positive(),
  date: z.string().date(),
  sessionType: z.enum(trainingTypeEnum.enumValues),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  structure: z.array(WorkoutStructureSetSchema).optional(),
  sortOrder: z.number().int().optional(),
});

trainingPlansRouter.post(
  "/:id/sessions",
  describeRoute({
    description: "Add a planned session to a training plan week.",
    responses: {
      201: {
        description: "Created planned session",
        content: { "application/json": { schema: resolver(PlannedSessionSchema) } },
      },
      404: {
        description: "Training plan or week not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", planIdParamSchema),
  validator("json", addSessionSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const session = await trainingPlanController.addSession(
      c.env.db,
      c.get("userId"),
      id,
      c.req.valid("json"),
    );
    return c.json(session, 201);
  },
);

const sessionParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  sessionId: z.coerce.number().int().positive(),
});

const updateSessionSchema = z
  .object({
    date: z.string().date().optional(),
    sessionType: z.enum(trainingTypeEnum.enumValues).optional(),
    title: z.string().min(1).optional(),
    description: z.string().min(1).nullable().optional(),
    structure: z.array(WorkoutStructureSetSchema).nullable().optional(),
    status: z.enum(plannedSessionStatusEnum.enumValues).optional(),
    sortOrder: z.number().int().optional(),
    weekId: z.number().int().positive().optional(),
  })
  .refine(atLeastOneField, { message: "At least one field must be provided" });

trainingPlansRouter.patch(
  "/:id/sessions/:sessionId",
  describeRoute({
    description:
      "Edit a planned session. Providing `weekId` moves it to another week of the same plan.",
    responses: {
      200: {
        description: "Updated planned session",
        content: { "application/json": { schema: resolver(PlannedSessionSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      404: {
        description: "Training plan, session, or target week not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", sessionParamSchema),
  validator("json", updateSessionSchema),
  async (c) => {
    const { id, sessionId } = c.req.valid("param");
    const session = await trainingPlanController.updateSession(
      c.env.db,
      c.get("userId"),
      id,
      sessionId,
      c.req.valid("json"),
    );
    return c.json(session);
  },
);

trainingPlansRouter.delete(
  "/:id/sessions/:sessionId",
  describeRoute({
    description: "Delete a planned session from a training plan.",
    responses: {
      200: {
        description: "Delete result",
        content: { "application/json": { schema: resolver(DeleteTrainingPlanResponseSchema) } },
      },
      404: {
        description: "Training plan or session not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", sessionParamSchema),
  async (c) => {
    const { id, sessionId } = c.req.valid("param");
    const result = await trainingPlanController.deleteSession(
      c.env.db,
      c.get("userId"),
      id,
      sessionId,
    );
    return c.json(result);
  },
);

const linkSessionSchema = z.object({
  activityId: z.number().int().positive(),
});

trainingPlansRouter.post(
  "/:id/sessions/:sessionId/link",
  describeRoute({
    description:
      "Link a planned session to a completed activity, marking it done. 409 if the activity is already linked to another session.",
    responses: {
      200: {
        description: "Linked planned session",
        content: { "application/json": { schema: resolver(PlannedSessionSchema) } },
      },
      404: {
        description: "Planned session or activity not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      409: {
        description: "Activity already linked to another planned session",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", sessionParamSchema),
  validator("json", linkSessionSchema),
  async (c) => {
    const { id, sessionId } = c.req.valid("param");
    const { activityId } = c.req.valid("json");
    const session = await trainingPlanController.linkSession(
      c.env.db,
      c.get("userId"),
      id,
      sessionId,
      activityId,
    );
    return c.json(session);
  },
);

trainingPlansRouter.delete(
  "/:id/sessions/:sessionId/link",
  describeRoute({
    description: "Unlink a planned session from its completed activity, reverting it to planned.",
    responses: {
      200: {
        description: "Unlinked planned session",
        content: { "application/json": { schema: resolver(PlannedSessionSchema) } },
      },
      404: {
        description: "Planned session not found or unauthorized",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("param", sessionParamSchema),
  async (c) => {
    const { id, sessionId } = c.req.valid("param");
    const session = await trainingPlanController.unlinkSession(
      c.env.db,
      c.get("userId"),
      id,
      sessionId,
    );
    return c.json(session);
  },
);

export default trainingPlansRouter;
