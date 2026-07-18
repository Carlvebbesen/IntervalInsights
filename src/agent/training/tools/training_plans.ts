import { z } from "zod";
import * as raceEventController from "../../../controllers/race_event_controller";
import * as trainingPlanController from "../../../controllers/training_plan_controller";
import { AppError } from "../../../error";
import {
  plannedSessionStatusEnum,
  planWeekPhaseEnum,
  raceEventStatusEnum,
  racePriorityEnum,
  trainingPlanStatusEnum,
  trainingTypeEnum,
} from "../../../schema/enums";
import { WorkoutStructureSetSchema } from "../../../schemas/agent_schemas";
import { defineTool } from "../tool_types";

const listTrainingPlans = defineTool({
  name: "list_training_plans",
  description:
    "List the user's training plans (draft, active, completed, or archived), newest first.",
  keywords: ["training plan", "plan", "training block", "race prep", "schedule"],
  requires: "db",
  params: z.object({
    status: z.enum(trainingPlanStatusEnum.enumValues).optional(),
  }),
  handler: (ctx, args) =>
    trainingPlanController.listTrainingPlans(ctx.db, ctx.userId, { status: args.status }),
});

const getTrainingPlan = defineTool({
  name: "get_training_plan",
  description:
    "Get a training plan's full detail: every week and planned session, including which ones are completed, skipped, or already linked to an activity.",
  keywords: ["training plan", "plan detail", "weeks", "sessions", "schedule"],
  requires: "db",
  params: z.object({ planId: z.number().int().positive() }),
  handler: (ctx, args) => trainingPlanController.getTrainingPlan(ctx.db, ctx.userId, args.planId),
});

const listRaceEvents = defineTool({
  name: "list_race_events",
  description:
    "List the user's race events (upcoming, completed, or cancelled) with distance, target time, and priority (A/B/C).",
  keywords: ["race", "race event", "goal race", "target race"],
  requires: "db",
  params: z.object({ status: z.enum(raceEventStatusEnum.enumValues).optional() }),
  handler: (ctx, args) =>
    raceEventController.listRaceEvents(ctx.db, ctx.userId, { status: args.status }),
});

const createRaceEvent = defineTool({
  name: "create_race_event",
  description:
    "Create a race event the user is training for: name, date, distance, and optionally a target time and priority (A/B/C, default B).",
  keywords: ["race", "create race", "new race", "goal race", "target race"],
  requires: "db",
  params: z.object({
    name: z.string().min(1),
    date: z.string().date(),
    distanceMeters: z.number().int().positive(),
    targetTimeSeconds: z.number().int().positive().optional(),
    priority: z.enum(racePriorityEnum.enumValues).optional(),
    status: z.enum(raceEventStatusEnum.enumValues).optional(),
  }),
  handler: (ctx, args) => raceEventController.createRaceEvent(ctx.db, ctx.userId, args),
});

const updateRaceEvent = defineTool({
  name: "update_race_event",
  description: "Edit a race event's name, date, distance, target time, priority, or status.",
  keywords: ["race", "update race", "edit race"],
  requires: "db",
  params: z.object({
    raceEventId: z.number().int().positive(),
    name: z.string().min(1).optional(),
    date: z.string().date().optional(),
    distanceMeters: z.number().int().positive().optional(),
    targetTimeSeconds: z.number().int().positive().nullable().optional(),
    priority: z.enum(racePriorityEnum.enumValues).optional(),
    status: z.enum(raceEventStatusEnum.enumValues).optional(),
  }),
  handler: (ctx, args) => {
    const { raceEventId, ...patch } = args;
    return raceEventController.updateRaceEvent(ctx.db, ctx.userId, raceEventId, patch);
  },
});

const deleteRaceEvent = defineTool({
  name: "delete_race_event",
  description: "Delete a race event.",
  keywords: ["race", "delete race", "remove race"],
  requires: "db",
  params: z.object({ raceEventId: z.number().int().positive() }),
  handler: (ctx, args) => raceEventController.deleteRaceEvent(ctx.db, ctx.userId, args.raceEventId),
});

const plannedSessionInputSchema = z.object({
  date: z.string().date(),
  sessionType: z.enum(trainingTypeEnum.enumValues),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  structure: z.array(WorkoutStructureSetSchema).optional(),
  sortOrder: z.number().int().optional(),
});

const planWeekInputSchema = z.object({
  weekIndex: z.number().int().nonnegative(),
  startDate: z.string().date(),
  phase: z.enum(planWeekPhaseEnum.enumValues).optional(),
  targetDistanceMeters: z.number().int().positive().optional(),
  targetLoad: z.number().int().positive().optional(),
  notes: z.string().min(1).optional(),
  sessions: z.array(plannedSessionInputSchema).optional(),
});

function assertNoDuplicateWeekIndex(weeks: z.infer<typeof planWeekInputSchema>[] | undefined) {
  if (!weeks) return;
  const seen = new Set<number>();
  for (const week of weeks) {
    if (seen.has(week.weekIndex)) {
      throw new AppError(400, "Duplicate weekIndex values are not allowed within a plan");
    }
    seen.add(week.weekIndex);
  }
}

const createTrainingPlan = defineTool({
  name: "create_training_plan",
  description:
    "Create a training plan, optionally with nested weeks and planned sessions (including workout structure) in a single call. A week's weekIndex must be unique within the plan.",
  keywords: ["training plan", "create plan", "new plan", "training block", "plan a race"],
  requires: "db",
  params: z.object({
    name: z.string().min(1),
    startDate: z.string().date(),
    endDate: z.string().date(),
    raceEventId: z.number().int().positive().optional(),
    goalText: z.string().min(1).optional(),
    status: z.enum(trainingPlanStatusEnum.enumValues).optional(),
    weeks: z.array(planWeekInputSchema).optional(),
  }),
  handler: (ctx, args) => {
    assertNoDuplicateWeekIndex(args.weeks);
    return trainingPlanController.createTrainingPlan(ctx.db, ctx.userId, args);
  },
});

const updateTrainingPlan = defineTool({
  name: "update_training_plan",
  description: "Edit a training plan's top-level fields: name, status, dates, race link, or goal.",
  keywords: ["training plan", "update plan", "edit plan"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    name: z.string().min(1).optional(),
    status: z.enum(trainingPlanStatusEnum.enumValues).optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().optional(),
    raceEventId: z.number().int().positive().nullable().optional(),
    goalText: z.string().min(1).nullable().optional(),
  }),
  handler: (ctx, args) => {
    const { planId, ...patch } = args;
    return trainingPlanController.updateTrainingPlan(ctx.db, ctx.userId, planId, patch);
  },
});

const deleteTrainingPlan = defineTool({
  name: "delete_training_plan",
  description: "Delete a training plan. Cascades to its weeks and planned sessions.",
  keywords: ["training plan", "delete plan", "remove plan"],
  requires: "db",
  params: z.object({ planId: z.number().int().positive() }),
  handler: (ctx, args) =>
    trainingPlanController.deleteTrainingPlan(ctx.db, ctx.userId, args.planId),
});

const addPlannedSession = defineTool({
  name: "add_planned_session",
  description: "Add a planned session to an existing week of a training plan.",
  keywords: ["planned session", "add session", "schedule workout", "training plan"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    weekId: z.number().int().positive(),
    date: z.string().date(),
    sessionType: z.enum(trainingTypeEnum.enumValues),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    structure: z.array(WorkoutStructureSetSchema).optional(),
    sortOrder: z.number().int().optional(),
  }),
  handler: (ctx, args) => {
    const { planId, ...input } = args;
    return trainingPlanController.addSession(ctx.db, ctx.userId, planId, input);
  },
});

const updatePlannedSession = defineTool({
  name: "update_planned_session",
  description:
    "Edit a planned session. Providing weekId moves it to another week of the same plan.",
  keywords: ["planned session", "update session", "edit session", "move session", "training plan"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    sessionId: z.number().int().positive(),
    date: z.string().date().optional(),
    sessionType: z.enum(trainingTypeEnum.enumValues).optional(),
    title: z.string().min(1).optional(),
    description: z.string().min(1).nullable().optional(),
    structure: z.array(WorkoutStructureSetSchema).nullable().optional(),
    status: z.enum(plannedSessionStatusEnum.enumValues).optional(),
    sortOrder: z.number().int().optional(),
    weekId: z.number().int().positive().optional(),
  }),
  handler: (ctx, args) => {
    const { planId, sessionId, ...patch } = args;
    return trainingPlanController.updateSession(ctx.db, ctx.userId, planId, sessionId, patch);
  },
});

const deletePlannedSession = defineTool({
  name: "delete_planned_session",
  description: "Delete a planned session from a training plan.",
  keywords: ["planned session", "delete session", "remove session", "training plan"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    sessionId: z.number().int().positive(),
  }),
  handler: (ctx, args) =>
    trainingPlanController.deleteSession(ctx.db, ctx.userId, args.planId, args.sessionId),
});

const linkPlannedSession = defineTool({
  name: "link_planned_session",
  description:
    "Link a planned session to a completed activity, marking the session done. Fails if the activity is already linked to another planned session.",
  keywords: ["link session", "planned session", "completed activity", "training plan"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    sessionId: z.number().int().positive(),
    activityId: z.number().int().positive(),
  }),
  handler: (ctx, args) =>
    trainingPlanController.linkSession(
      ctx.db,
      ctx.userId,
      args.planId,
      args.sessionId,
      args.activityId,
    ),
});

const unlinkPlannedSession = defineTool({
  name: "unlink_planned_session",
  description: "Unlink a planned session from its completed activity, reverting it to planned.",
  keywords: ["unlink session", "planned session", "training plan"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    sessionId: z.number().int().positive(),
  }),
  handler: (ctx, args) =>
    trainingPlanController.unlinkSession(ctx.db, ctx.userId, args.planId, args.sessionId),
});

export const trainingPlanTools = [
  listTrainingPlans,
  getTrainingPlan,
  listRaceEvents,
  createRaceEvent,
  updateRaceEvent,
  deleteRaceEvent,
  createTrainingPlan,
  updateTrainingPlan,
  deleteTrainingPlan,
  addPlannedSession,
  updatePlannedSession,
  deletePlannedSession,
  linkPlannedSession,
  unlinkPlannedSession,
];
