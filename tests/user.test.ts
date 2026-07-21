import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../src/schema";
import { closePool, createTestUser, deleteTestUser, getDb, getPool } from "./helpers/db";
import { buildTestApp, type TestIdentity, withIdentity } from "./helpers/test_app";

const app = buildTestApp(getPool());

let user: { id: string; email: string };

beforeAll(async () => {
  user = await createTestUser({ role: "premium" });
});

afterAll(async () => {
  await deleteTestUser(user.id);
  await closePool();
});

const identity = () => ({
  userId: user.id,
  role: "premium" as const,
});

describe("/api/user", () => {
  it("GET / returns the authed user", () =>
    withIdentity(identity(), async () => {
      const res = await app.fetch(new Request("http://test/api/v1/user"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(user.id);
      expect(body.email).toBe(user.email);
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

describe("/api/admin — role management", () => {
  const storedRole = async (userId: string) => {
    const row = await getDb().query.users.findFirst({ where: eq(users.id, userId) });
    return row?.role;
  };

  const patchRole = (actor: { id: string; email: string }, actorRole: TestIdentity["role"], targetId: string, body: unknown) =>
    withIdentity({ userId: actor.id, role: actorRole }, () =>
      app.fetch(
        new Request(`http://test/api/v1/admin/users/${targetId}/role`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );

  it("admin can set a non-admin role on a non-admin user", async () => {
    const adminUser = await createTestUser({ role: "admin" });
    const target = await createTestUser({ role: "guest" });
    try {
      const res = await patchRole(adminUser, "admin", target.id, { role: "premium" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.role).toBe("premium");
      expect(await storedRole(target.id)).toBe("premium");
    } finally {
      await deleteTestUser(adminUser.id);
      await deleteTestUser(target.id);
    }
  });

  it("a guest cannot set any role on themselves", async () => {
    const guestUser = await createTestUser({ role: "guest" });
    try {
      for (const role of ["guest", "premium", "admin"] as const) {
        const res = await patchRole(guestUser, "guest", guestUser.id, { role });
        expect(res.status).toBe(403);
      }
      expect(await storedRole(guestUser.id)).toBe("guest");
    } finally {
      await deleteTestUser(guestUser.id);
    }
  });

  it("a premium user cannot set any role either", async () => {
    const premiumUser = await createTestUser({ role: "premium" });
    try {
      for (const role of ["guest", "premium", "admin"] as const) {
        const res = await patchRole(premiumUser, "premium", premiumUser.id, { role });
        expect(res.status).toBe(403);
      }
      expect(await storedRole(premiumUser.id)).toBe("premium");
    } finally {
      await deleteTestUser(premiumUser.id);
    }
  });

  it("an admin cannot grant the admin role", async () => {
    const adminUser = await createTestUser({ role: "admin" });
    const target = await createTestUser({ role: "guest" });
    try {
      const res = await patchRole(adminUser, "admin", target.id, { role: "admin" });
      // Rejected by the request schema — admin is not an accepted value.
      expect(res.status).toBe(400);
      expect(await storedRole(target.id)).toBe("guest");
    } finally {
      await deleteTestUser(adminUser.id);
      await deleteTestUser(target.id);
    }
  });

  it("an admin cannot change another admin's role", async () => {
    const adminUser = await createTestUser({ role: "admin" });
    const otherAdmin = await createTestUser({ role: "admin" });
    try {
      for (const role of ["guest", "premium"] as const) {
        const res = await patchRole(adminUser, "admin", otherAdmin.id, { role });
        expect(res.status).toBe(403);
      }
      expect(await storedRole(otherAdmin.id)).toBe("admin");
    } finally {
      await deleteTestUser(adminUser.id);
      await deleteTestUser(otherAdmin.id);
    }
  });

  it("an admin cannot demote themselves", async () => {
    const adminUser = await createTestUser({ role: "admin" });
    try {
      const res = await patchRole(adminUser, "admin", adminUser.id, { role: "guest" });
      expect(res.status).toBe(403);
      expect(await storedRole(adminUser.id)).toBe("admin");
    } finally {
      await deleteTestUser(adminUser.id);
    }
  });
});
