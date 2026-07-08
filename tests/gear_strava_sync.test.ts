// Gear sync/import reconciliation against Strava (real db + mocked Strava API):
// - a legacy bike mis-imported as SHOES is flipped to BICYCLE on resync
// - a lazily-imported MTB-frame bike on a plain "Ride" gets an MTB surface

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { gears } from "../src/schema";
import * as gearRepo from "../src/repositories/gear_repository";
import {
  linkActivityGearOnIngest,
  syncUserGearFromStrava,
} from "../src/services/gear_strava_service";
import { stravaApiService } from "../src/services/strava_api_service";
import { closePool, createTestUser, deleteTestUser, getDb } from "./helpers/db";
import { insertActivity } from "./helpers/fixtures";

const db = getDb();

let user: { id: string; clerkId: string };

const realGetAthlete = stravaApiService.getAthlete;
const realGetGear = stravaApiService.getGear;

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterEach(() => {
  stravaApiService.getAthlete = realGetAthlete;
  stravaApiService.getGear = realGetGear;
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

describe("syncUserGearFromStrava gearType reconciliation", () => {
  it("flips a legacy SHOES row whose stravaGearId is a bike to BICYCLE with a valid surface", async () => {
    const stravaGearId = "b-legacy-1";
    const legacy = await gearRepo.create(db, user.id, {
      gearType: "SHOES",
      brand: null,
      model: "Mislabelled Bike",
      nickname: null,
      surface: "ROAD",
      isActive: true,
      retiredAt: null,
      stravaGearId,
      baselineDistanceMeters: 0,
      baselineDate: new Date(),
    });

    stravaApiService.getAthlete = (async () => ({
      shoes: [],
      bikes: [
        { id: stravaGearId, name: "Trek Fuel", distance: 5000, retired: false, frame_type: 1 },
      ],
    })) as unknown as typeof stravaApiService.getAthlete;

    await syncUserGearFromStrava(db, user.id, "tok");

    const reconciled = await gearRepo.findByStravaGearId(db, user.id, stravaGearId);
    expect(reconciled?.id).toBe(legacy.id);
    expect(reconciled?.gearType).toBe("BICYCLE");
    expect(reconciled?.surface).toBe("MTB");
  });
});

describe("importGearFromStrava surface derivation (via lazy ingest)", () => {
  it("gives an MTB-frame bike on a plain Ride an MTB surface, not ROAD", async () => {
    const stravaGearId = "b-ingest-1";
    stravaApiService.getGear = (async () => ({
      id: stravaGearId,
      name: "Specialized Epic",
      distance: 1000,
      retired: false,
      frame_type: 1,
    })) as unknown as typeof stravaApiService.getGear;

    const activity = await insertActivity(user.id, { sportType: "Ride" });
    await linkActivityGearOnIngest(db, user.id, "tok", activity.id, {
      stravaGearId,
      sportType: "Ride",
      startDateLocal: new Date(),
    });

    const imported = await gearRepo.findByStravaGearId(db, user.id, stravaGearId);
    expect(imported?.gearType).toBe("BICYCLE");
    expect(imported?.surface).toBe("MTB");
  });
});
