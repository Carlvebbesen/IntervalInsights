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
import {
  PlanRevisionChangeSchema,
  WorkoutStructureSetSchema,
} from "../../../schemas/agent_schemas";
import { type CoachTool, defineTool } from "../tool_types";

const listTrainingPlans = defineTool({
  name: "list_training_plans",
  description:
    "List the user's training plans (draft, active, completed, or archived), newest first, each with its goal and scheduling constraints.",
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
    "Get a training plan's full detail: its goal and scheduling constraints, every week and planned session, including which ones are completed, skipped, or already linked to an activity.",
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
    "Create a training plan, optionally with nested weeks and planned sessions (including workout structure) in a single call. A week's weekIndex must be unique within the plan. Pass constraintsText to record the athlete's fixed scheduling/logistics preferences (e.g. a recurring Saturday club long run, no running Fridays). Never include target paces — the plan stores intent, and any paces you send are stripped. The response may include a `warnings` array flagging weeks that breach the athlete's safe ramp, long-run spike, quality-session, run-day or weekly-volume limits; the plan is still saved. ALWAYS tell the athlete about any warnings in plain language and offer to fix the flagged week — never ignore them or hide them.",
  keywords: ["training plan", "create plan", "new plan", "training block", "plan a race"],
  requires: "db",
  params: z.object({
    name: z.string().min(1),
    startDate: z.string().date(),
    endDate: z.string().date(),
    raceEventId: z.number().int().positive().optional(),
    goalText: z.string().min(1).optional(),
    constraintsText: z.string().min(1).optional(),
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
  description:
    "Edit a training plan's top-level fields: name, status, dates, race link, goal, or scheduling constraints (free-text recurring commitments / unavailable days).",
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
    constraintsText: z.string().min(1).nullable().optional(),
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

const addPlanWeek = defineTool({
  name: "add_plan_week",
  description: "Add a week to an existing training plan. weekIndex must be unique within the plan.",
  keywords: ["training plan", "add week", "plan week", "schedule week"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    weekIndex: z.number().int().nonnegative(),
    startDate: z.string().date(),
    phase: z.enum(planWeekPhaseEnum.enumValues).optional(),
    targetDistanceMeters: z.number().int().positive().optional(),
    targetLoad: z.number().int().positive().optional(),
    notes: z.string().min(1).optional(),
  }),
  handler: (ctx, args) => {
    const { planId, ...input } = args;
    return trainingPlanController.addWeek(ctx.db, ctx.userId, planId, input);
  },
});

const updatePlanWeek = defineTool({
  name: "update_plan_week",
  description:
    "Edit a week belonging to a training plan: its index, start date, phase, targets, or notes.",
  keywords: ["training plan", "update week", "edit week", "plan week"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    weekId: z.number().int().positive(),
    weekIndex: z.number().int().nonnegative().optional(),
    startDate: z.string().date().optional(),
    phase: z.enum(planWeekPhaseEnum.enumValues).nullable().optional(),
    targetDistanceMeters: z.number().int().positive().nullable().optional(),
    targetLoad: z.number().int().positive().nullable().optional(),
    notes: z.string().min(1).nullable().optional(),
  }),
  handler: (ctx, args) => {
    const { planId, weekId, ...patch } = args;
    return trainingPlanController.updateWeek(ctx.db, ctx.userId, planId, weekId, patch);
  },
});

const deletePlanWeek = defineTool({
  name: "delete_plan_week",
  description: "Delete a week from a training plan. Cascades to its planned sessions.",
  keywords: ["training plan", "delete week", "remove week", "plan week"],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    weekId: z.number().int().positive(),
  }),
  handler: (ctx, args) =>
    trainingPlanController.deleteWeek(ctx.db, ctx.userId, args.planId, args.weekId),
});

const addPlannedSession = defineTool({
  name: "add_planned_session",
  description:
    "Add a planned session to an existing week of a training plan. Never include target paces — the plan stores intent, and any paces you send are stripped. The response may include a `warnings` array if the session pushes its week past the athlete's safe ramp, long-run spike, quality-session, run-day or weekly-volume limits; the session is still saved. ALWAYS surface any warnings to the athlete and offer to adjust — never ignore them.",
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
    "Edit a planned session. Providing weekId moves it to another week of the same plan. Never include target paces — the plan stores intent, and any paces you send are stripped. The response may include a `warnings` array if the edit pushes the affected week past the athlete's safe ramp, long-run spike, quality-session, run-day or weekly-volume limits; the edit is still saved. ALWAYS surface any warnings to the athlete and offer to adjust — never ignore them.",
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

const applyPlanRevision = defineTool({
  name: "apply_plan_revision",
  description:
    "Apply a set of previously-proposed changes to a training plan: move/update/drop a session, add a session, or update a week's targets. Every change is validated (plan ownership, every sessionId/weekId belongs to this plan) and applied atomically — an invalid reference rejects the whole batch, nothing partially applies. The revision (with optional rationale) is recorded in the plan's history. Per policy, ALWAYS call create_plan_revision FIRST to show the athlete the proposal, and only call this tool after the athlete has explicitly confirmed they want it applied — never apply a revision silently. Never include target paces — the plan stores intent, and any paces you send are stripped. The response may include a `warnings` array flagging weeks the revision leaves past the athlete's safe ramp, long-run spike, quality-session, run-day or weekly-volume limits; the revision is still applied. ALWAYS report any warnings back to the athlete and offer to adjust — never ignore them.",
  keywords: [
    "training plan",
    "apply revision",
    "revise plan",
    "move session",
    "update plan",
    "plan revision",
    "confirm changes",
  ],
  requires: "db",
  params: z.object({
    planId: z.number().int().positive(),
    rationale: z.string().min(1).optional(),
    changes: z.array(PlanRevisionChangeSchema).min(1),
  }),
  handler: (ctx, args) =>
    trainingPlanController.applyPlanRevision(
      ctx.db,
      ctx.userId,
      args.planId,
      args.changes,
      args.rationale,
    ),
});

// The whole training-plan feature is premium-only, matching the REST gate on
// `training_plans_router` / `race_events_router` — these tools reach the very
// same controllers. Stamped on the array rather than per tool so a tool added
// here can't silently arrive ungated.
export const trainingPlanTools: CoachTool[] = [
  listTrainingPlans,
  getTrainingPlan,
  listRaceEvents,
  createRaceEvent,
  updateRaceEvent,
  deleteRaceEvent,
  createTrainingPlan,
  updateTrainingPlan,
  deleteTrainingPlan,
  addPlanWeek,
  updatePlanWeek,
  deletePlanWeek,
  addPlannedSession,
  updatePlannedSession,
  deletePlannedSession,
  linkPlannedSession,
  unlinkPlannedSession,
  applyPlanRevision,
].map((tool) => ({ ...tool, premium: true }));
