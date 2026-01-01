import {
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { IntervalType, intervalTypeEnum, TargetTypeEnum, TrainingType, trainingTypeEnum, workoutPartEnum, WorkoutPartType } from "./enums";
import { relations, eq } from "drizzle-orm";
import { activities } from "./activities";
import { IGlobalBindings } from "../types/IRouters";
import { InsertIntervalSegment } from "./interval_segments";
import { workoutBlock } from "../agent/initial_analysis_agent";
import z from "zod";

export const intervalStructures = pgTable("interval_structures", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  signature: text("signature").unique(),
  trainingType: trainingTypeEnum("training_type").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  intervalType: intervalTypeEnum("interval_type"),
});

export const intervalStructuresRelations = relations(
  intervalStructures,
  ({ many }) => ({
    activities: many(activities),
  })
);

export type IntervalComponent = {
  value: number;
  unit: 'm' | 'km' | 'sec' | 'min';
};
export const normalize = (val: number, unit: IntervalComponent['unit']): number => {
  switch (unit) {
    case 'km': return val * 1000;
    case 'min': return val * 60;
    default: return val;
  }
};

export const generateIntervalSignature = (
  structure: IntervalComponent | IntervalComponent[]
): string => {
  if (!Array.isArray(structure)) {
    const unitType = ['m', 'km'].includes(structure.unit) ? 'm' : 's';
    return `${normalize(structure.value, structure.unit)}${unitType}`;
  }
  const parts = [
    ...new Set(structure.map(s => generateIntervalSignature(s)))
  ]
    .sort()
    .join('-');
  return `${parts}`;
};

export const mapBlocksToComponents = (blocks: z.infer<typeof workoutBlock>[]): IntervalComponent[] => {
  return blocks.map(b => ({
    value: b.work_value,
    unit: b.work_type === "DISTANCE" ? 'm' : 'sec'
  }));
};

const mapSegmentsToComponents = (segments: InsertIntervalSegment[]): IntervalComponent[] => {
  const coreSegments = segments.filter(s => s.type === "INTERVALS");

  return coreSegments.map((seg) => {
    let unit: IntervalComponent['unit'] = 'sec'; 
    if (seg.targetType === "distance") {
      unit = 'm';
    } else if (seg.targetType === "time") {
      unit = 'sec';
    }
    return {
      value: seg.targetValue,
      unit: unit,
    };
  });
};
export const generateStructureName = (components: IntervalComponent[]): string => {
  if (!components || components.length === 0) return "Free Workout";

  const normalizedStrings = components.map(c => {
    const val = normalize(c.value, c.unit);
    
    const label = (c.unit === 'km' || c.unit === 'm') ? 'm' : 's';
    
    return `${val}${label}`;
  });

  const uniqueTypes = Array.from(new Set(normalizedStrings));

  if (uniqueTypes.length === 1) {
    return `(n)x ${uniqueTypes[0]}`; 
  }

  return `Mixed (${uniqueTypes.join('/')})`;
};
export const determineIntervalType = (segments:InsertIntervalSegment[] ): IntervalType => {
  const workSegments = segments.filter((s) => s.type === "INTERVALS");
  if (workSegments.length === 0) return "THRESHOLD";
  const count = workSegments.length;
  const getMetrics = (seg: InsertIntervalSegment) => {
    const isDist = seg.targetType === "distance";
    const dist = isDist ? seg.targetValue : 0; 
    const time = !isDist ? seg.targetValue : 0; 
    return { dist, time };
  };

  const stats = workSegments.reduce(
    (acc, seg) => {
      const { dist, time } = getMetrics(seg);
      return {
        totalDist: acc.totalDist + dist,
        totalTime: acc.totalTime + time,
        maxDist: Math.max(acc.maxDist, dist),
        maxTime: Math.max(acc.maxTime, time),
        totalElevation: acc.totalElevation,
        variations: acc.variations.concat(seg.targetValue)
      };
    },
    { totalDist: 0, totalTime: 0, maxDist: 0, maxTime: 0, totalElevation: 0, variations: [] as number[] }
  );
  const avgDist = stats.totalDist / count;
  const avgTime = stats.totalTime / count; 
  const isDistanceBased = workSegments.every(s => s.targetType === "distance");
  const isTimeBased = workSegments.every(s => s.targetType === "time");
  const uniqueTargets = new Set(stats.variations);
  if (uniqueTargets.size > 3 && count > 5) {
    return "FARTLEK";
  }
  const avgElevation = stats.totalElevation / count;
  const isShortDistance = isDistanceBased && avgDist < 300;
  const isShortTime = isTimeBased && avgTime < 90;
  
  if ((isShortDistance || isShortTime) && avgElevation > 10) { 
    return "HILL_SPRINTS";
  }
  if (isTimeBased && avgTime <= 30) return "SPRINTS";
  if (isDistanceBased && avgDist <= 200) return "SPRINTS";
  if ((isTimeBased && avgTime < 120) || (isDistanceBased && avgDist < 800)) {
    return "ANAEROBIC_CAPACITY";
  }
  if ((isTimeBased && avgTime > 359) || (isDistanceBased && avgDist > 999)) {
    return "THRESHOLD";
  }
  if ((isTimeBased && avgTime >= 120) || (isDistanceBased && avgDist >= 800)) {
    return "VO2_MAX";
  }
  return "RECOVERY_INTERVALS";
};


export const findOrCreateIntervalStructure = async (
  db: IGlobalBindings["db"],
  segments: InsertIntervalSegment[],
  trainingType: TrainingType,
) => {
  const components = mapSegmentsToComponents(segments);
  const signature = generateIntervalSignature(components);
  const existingStructure = await db
    .select()
    .from(intervalStructures)
    .where(eq(intervalStructures.signature, signature))
    .limit(1);
  if (existingStructure.length > 0) {
    return existingStructure[0];
  }
  const newName = generateStructureName(components);
  const intervalType = determineIntervalType(segments);
  const [newStructure] = await db
    .insert(intervalStructures)
    .values({
      name: newName,
      signature: signature,
      trainingType: trainingType,
      intervalType: intervalType,
    })
    .returning();
  return newStructure;
};