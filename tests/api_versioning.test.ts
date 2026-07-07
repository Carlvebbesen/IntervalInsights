// Guards the transitional dual-mount (src/index.ts): during the /api/v1 rollout the
// authed routers must be reachable at BOTH the legacy /api/* (which already-installed
// app builds call) and the new /api/v1/*. Delete this file when the legacy mount is
// removed. See docs/backend-followups-plan.md, Phase 0.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closePool, createTestUser, deleteTestUser, getPool } from "./helpers/db";
import { buildTestApp, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; clerkId: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  clerkUserId: user.clerkId,
  role: "premium" as const,
});

describe("api versioning — transitional dual-mount", () => {
  it("serves an authed route identically at legacy /api/* and /api/v1/*", () =>
    withIdentity(identity(), async () => {
      const legacy = await app.fetch(new Request("http://test/api/user"));
      const versioned = await app.fetch(new Request("http://test/api/v1/user"));

      expect(legacy.status).toBe(200);
      expect(versioned.status).toBe(200);
      expect(await legacy.json()).toEqual(await versioned.json());
    }));

  it("keeps public routes unversioned (legacy /api only, not /api/v1)", () =>
    withIdentity(identity(), async () => {
      const health = await app.fetch(new Request("http://test/api/health"));
      expect(health.status).toBe(200);

      // The public router is NOT part of the v1 sub-app, so it must 404 under /api/v1.
      const healthV1 = await app.fetch(new Request("http://test/api/v1/health"));
      expect(healthV1.status).toBe(404);
    }));
});
