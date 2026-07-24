// The /pending gear preselect chain: deliberate Strava change → signature
// default → use-type match → (bucket, surface) default → recents, with retired
// gear skipped at every step.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { gearDefaults, gearSignatureDefaults, gears } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { insertActivity, insertIntervalStructure } from "./helpers/fixtures";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());
const db = getDb();

let user: { id: string; email: string };
let shoeStrava: number;
let shoeSig: number;
let shoeType: number;
let shoeBucket: number;
let shoeRetired: number;
let structureId: number;
let aStrava: number;
let aSig: number;
let aType: number;
let aRetired: number;
let bike: number;
let aRide: number;
let trailShoe: number;
let aTrail: number;

async function insertGear(
  model: string,
  overrides: Partial<typeof gears.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(gears)
    .values({ userId: user.id, model, surface: "ROAD", ...overrides })
    .returning({ id: gears.id });
  return row.id;
}

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });

  shoeStrava = await insertGear("Strava Choice");
  shoeSig = await insertGear("Signature Default");
  shoeType = await insertGear("Tempo Shoe", { useTypes: ["TEMPO"] });
  shoeBucket = await insertGear("Bucket Default");
  shoeRetired = await insertGear("Retired Tempo Shoe", {
    useTypes: ["TEMPO"],
    isActive: false,
    retiredAt: new Date(),
  });

  const structure = await insertIntervalStructure({ name: "tempo sig", trainingType: "TEMPO" });
  structureId = structure.id;
  await db
    .insert(gearSignatureDefaults)
    .values({ userId: user.id, intervalStructureId: structureId, gearId: shoeSig });
  await db
    .insert(gearDefaults)
    .values({ userId: user.id, bucket: "INTERVALS", surface: "ROAD", gearId: shoeBucket });

  const base = { analysisStatus: "pending" as const, trainingType: "TEMPO" as const };
  aStrava = (
    await insertActivity(user.id, {
      ...base,
      gearUpdatedFromStrava: true,
      localGearId: shoeStrava,
      intervalStructureId: structureId,
    })
  ).id;
  aSig = (await insertActivity(user.id, { ...base, intervalStructureId: structureId })).id;
  aType = (await insertActivity(user.id, base)).id;
  aRetired = (
    await insertActivity(user.id, {
      ...base,
      gearUpdatedFromStrava: true,
      localGearId: shoeRetired,
      intervalStructureId: structureId,
    })
  ).id;

  // A bicycle + a prior ride using it feeds recents-by-type for BICYCLE.
  bike = await insertGear("Bike One", { gearType: "BICYCLE", surface: "ROAD" });
  await insertActivity(user.id, {
    sportType: "Ride",
    localGearId: bike,
    analysisStatus: "completed",
    trainingType: "EASY",
  });
  aRide = (
    await insertActivity(user.id, {
      sportType: "Ride",
      analysisStatus: "pending",
      trainingType: "EASY",
    })
  ).id;

  // A trail shoe with the same TEMPO use-type as the road `shoeType`. A pending
  // TrailRun (surface TRAIL) must prefer the trail shoe — the surface-scoped
  // use-type/recents steps exclude the road shoe.
  trailShoe = await insertGear("Trail Tempo Shoe", { surface: "TRAIL", useTypes: ["TEMPO"] });
  aTrail = (
    await insertActivity(user.id, {
      sportType: "TrailRun",
      analysisStatus: "pending",
      trainingType: "TEMPO",
    })
  ).id;
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

type PendingRow = {
  id: number;
  suggestedGearId: number | null;
  gearSuggestions: number[];
  gearUpdatedFromStrava: boolean;
  intervalStructureId: number | null;
};

async function fetchPending(): Promise<Map<number, PendingRow>> {
  return withIdentity(
    { userId: user.id, role: "premium" },
    async () => {
      const res = await app.fetch(new Request("http://test/api/v1/agents/pending"));
      expect(res.status).toBe(200);
      const body: PendingRow[] = await res.json();
      return new Map(body.map((r) => [r.id, r]));
    },
  );
}

describe("GET /api/v1/agents/pending gear preselect chain", () => {
  it("applies the priority order and never suggests retired gear", async () => {
    const pending = await fetchPending();

    // 1. The user's deliberate Strava choice wins over the signature default.
    const strava = pending.get(aStrava);
    expect(strava?.suggestedGearId).toBe(shoeStrava);
    expect(strava?.gearUpdatedFromStrava).toBe(true);
    expect(strava?.intervalStructureId).toBe(structureId);

    // 2. Signature default wins over the use-type match.
    expect(pending.get(aSig)?.suggestedGearId).toBe(shoeSig);

    // 3. Use-type match wins over the bucket default, which still follows.
    const type = pending.get(aType);
    expect(type?.suggestedGearId).toBe(shoeType);
    expect(type?.gearSuggestions[1]).toBe(shoeBucket);

    // 4. A retired Strava choice is skipped: falls through to the signature default.
    expect(pending.get(aRetired)?.suggestedGearId).toBe(shoeSig);

    for (const row of pending.values()) {
      expect(row.gearSuggestions).not.toContain(shoeRetired);
      expect(row.suggestedGearId).not.toBe(shoeRetired);
    }
  });

  it("keys candidates on gear type: a ride suggests the bike, never shoes", async () => {
    const pending = await fetchPending();
    const ride = pending.get(aRide);
    expect(ride?.suggestedGearId).toBe(bike);
    for (const id of [shoeStrava, shoeSig, shoeType, shoeBucket, shoeRetired]) {
      expect(ride?.gearSuggestions).not.toContain(id);
    }
  });

  it("surface-scopes use-type/recents: a TrailRun prefers the trail shoe over a road TEMPO shoe", async () => {
    const pending = await fetchPending();
    const trail = pending.get(aTrail);
    expect(trail?.suggestedGearId).toBe(trailShoe);
    expect(trail?.gearSuggestions).not.toContain(shoeType);
  });
});
