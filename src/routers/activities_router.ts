import { Hono } from "hono";
import { TGlobalEnv } from "../types/IRouters";
import { activities, trainingTypeEnum, intervalSegments } from "../schema";
import { eq, desc, asc, inArray, and, or, ilike, gte } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import z from "zod";

const activitiesRouter = new Hono<TGlobalEnv>();
const PAGE_SIZE = 15;

const querySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  search: z.string().optional(),
  distance: z.coerce.number().optional(),
  trainingType: z.enum(trainingTypeEnum.enumValues).optional(),
});

activitiesRouter.get("/", zValidator("query", querySchema), async (c) => {
  try {
    const userId = c.get("userId");
    const { page, search, distance, trainingType } = c.req.valid("query");
    const filters = [];
    filters.push(eq(activities.userId, userId));
    filters.push(eq(activities.analysisStatus, "completed"));
    if (search) {
      filters.push(
        or(
          ilike(activities.title, `%${search}%`),
          ilike(activities.description, `%${search}%`)
        )
      );
    }
    if (trainingType) {
      filters.push(eq(activities.trainingType, trainingType as any));
    }
    if (distance) {
      if (!isNaN(distance)) {
        filters.push(gte(activities.distance, distance));
      }
    }
    const result = await c.env.db
      .select()
      .from(activities)
      .where(and(...filters))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE)
      .orderBy(desc(activities.startDateLocal));
    return c.json({
      data: result,
      meta: {
        page,
        pageSize: PAGE_SIZE,
        filterApplied: { search, trainingType, distance: distance },
      },
    });
  } catch (error) {
    console.error("Error fetching activities:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
activitiesRouter.get("/:id/segments", async (c) => {
  try {
    const activityId = parseInt(c.req.param("id"));
    console.log(`AcitityDetails for${activityId} `)
    if (isNaN(activityId)) {
      return c.json({ error: "Invalid activity ID" }, 400);
    }
    const segments = await c.env.db
    .select()
    .from(intervalSegments)
    .where(eq(intervalSegments.activityId, activityId))
    .orderBy(asc(intervalSegments.segmentIndex));
    
    return c.json({
      intervalSegments: segments,
    });
  } catch (error) {
    console.error("Error fetching activity:", error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});


const updateActivitySchema = z.object({
  id: z.number(),
  trainingType: z.enum(trainingTypeEnum.enumValues).nullable().optional(),
  notes: z.string().nullable().optional(),
  feeling: z.number().nullable().optional(),
});
activitiesRouter.post("/update", async (c) => {
  try {
    const body = await c.req.json();
    const { id, ...data } = updateActivitySchema.parse(body);
    if (Object.keys(data).length === 0) {
      return c.json({ error: "No fields provided for update" }, 400);
    }

    const userId = c.get("userId");
    const updated = await c.env.db
      .update(activities)
      .set(data)
      .where(and(eq(activities.id, id), eq(activities.userId, userId)))
      .returning();

    if (updated.length === 0) {
      return c.json({ error: "Activity not found or unauthorized" }, 404);
    }
    return c.json(updated[0]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ error: "Invalid input", details: error.errors }, 400);
    }
    console.error(error);
    return c.json({ error: "Internal Server Error" }, 500);
  }
});
export default activitiesRouter;
