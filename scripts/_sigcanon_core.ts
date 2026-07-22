export interface ActivityPlan {
  userId: string;
  oldStructureId: number;
  newSignature: string;
}

export interface GearDefaultRow {
  userId: string;
  intervalStructureId: number;
  createdAt: Date;
}

export interface GearDefaultMove {
  userId: string;
  fromStructureId: number;
  /** Canonical signature this user's activities under `fromStructureId` moved to. */
  targetSignature: string;
  /** repoint: follow the merge. drop: a newer default of this user already claims the target. */
  action: "repoint" | "drop";
}

export interface GearDefaultPlan {
  moves: GearDefaultMove[];
  /** Defaults we cannot place: the user has no activity under that structure. */
  stranded: GearDefaultRow[];
}

/**
 * A gear default pins "this gear, for this workout shape", so it has to follow its
 * structure through the merge — otherwise the pin survives on a structure nothing
 * references any more and silently stops matching the user's sessions.
 *
 * The target is derived per user: structures are global, so the same old structure can
 * fan out to different canonical shapes for different athletes. Where a user's own
 * activities disagree, the most common signature wins (ties broken lexicographically so
 * the result never depends on row order).
 */
export function planGearDefaultMoves(plans: ActivityPlan[], defaults: GearDefaultRow[]): GearDefaultPlan {
  const counts = new Map<string, Map<string, number>>();
  for (const p of plans) {
    const key = `${p.userId}:${p.oldStructureId}`;
    const bySig = counts.get(key) ?? new Map<string, number>();
    bySig.set(p.newSignature, (bySig.get(p.newSignature) ?? 0) + 1);
    counts.set(key, bySig);
  }

  const dominant = (userId: string, structureId: number): string | null => {
    const bySig = counts.get(`${userId}:${structureId}`);
    if (!bySig) return null;
    return [...bySig.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  };

  const stranded: GearDefaultRow[] = [];
  const placed: Array<{ row: GearDefaultRow; targetSignature: string }> = [];
  for (const row of defaults) {
    const targetSignature = dominant(row.userId, row.intervalStructureId);
    if (targetSignature === null) stranded.push(row);
    else placed.push({ row, targetSignature });
  }

  // Two of a user's defaults can land on the same canonical structure — the composite
  // primary key allows only one. The most recently pinned gear is the live intent.
  const winner = new Map<string, { row: GearDefaultRow; targetSignature: string }>();
  for (const p of placed) {
    const key = `${p.row.userId}:${p.targetSignature}`;
    const held = winner.get(key);
    const better =
      !held ||
      p.row.createdAt > held.row.createdAt ||
      (p.row.createdAt.getTime() === held.row.createdAt.getTime() &&
        p.row.intervalStructureId < held.row.intervalStructureId);
    if (better) winner.set(key, p);
  }

  const moves = placed.map(({ row, targetSignature }) => ({
    userId: row.userId,
    fromStructureId: row.intervalStructureId,
    targetSignature,
    action:
      winner.get(`${row.userId}:${targetSignature}`)?.row.intervalStructureId === row.intervalStructureId
        ? ("repoint" as const)
        : ("drop" as const),
  }));

  return { moves, stranded };
}
