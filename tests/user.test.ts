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

describe("/api/user", () => {
  it("GET / returns the authed user", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/user"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(user.id);
      expect(body.clerkId).toBe(user.clerkId);
      expect(typeof body.currentPrivacyPolicyVersion).toBe("string");
      expect(typeof body.currentTermsOfServiceVersion).toBe("string");
    }));

  it("PATCH / updates maxHeartRate and processHeartRate", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/user", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxHeartRate: 195, processHeartRate: true }),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.maxHeartRate).toBe(195);
      expect(body.processHeartRate).toBe(true);
    }));

  it("PATCH / rejects empty body", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/user", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(400);
    }));

  it("POST /accept-privacy-policy records acceptance", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/user/accept-privacy-policy", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.privacyPolicyAcceptedAt).not.toBeNull();
      expect(body.privacyPolicyVersion).toBe(body.currentPrivacyPolicyVersion);
    }));

  it("POST /accept-terms-of-service records acceptance", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(
        new Request("http://test/api/v1/user/accept-terms-of-service", {
          method: "POST",
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.termsOfServiceAcceptedAt).not.toBeNull();
      expect(body.termsOfServiceVersion).toBe(body.currentTermsOfServiceVersion);
    }));
});

describe("/api/user — admin gate", () => {
  it("admin role can hit /api/admin", async () => {
    const adminUser = await createTestUser({ role: "admin" });
    try {
      const res = await withIdentity(
        { userId: adminUser.id, clerkUserId: adminUser.clerkId, role: "admin" },
        () =>
          app.fetch(
            new Request(`http://test/api/v1/admin/users/${adminUser.id}/role`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: "premium" }),
            }),
          ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.role).toBe("premium");
    } finally {
      await deleteTestUser(adminUser.id);
    }
  });

  it("non-admin role gets 403 on /api/admin", async () => {
    const guestUser = await createTestUser({ role: "guest" });
    try {
      const res = await withIdentity(
        { userId: guestUser.id, clerkUserId: guestUser.clerkId, role: "guest" },
        () =>
          app.fetch(
            new Request(`http://test/api/v1/admin/users/${guestUser.id}/role`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: "admin" }),
            }),
          ),
      );
      expect(res.status).toBe(403);
    } finally {
      await deleteTestUser(guestUser.id);
    }
  });
});
