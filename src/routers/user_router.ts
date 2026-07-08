import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import * as userController from "../controllers/user_controller";
import { DeleteAccountResponseSchema, ErrorSchema, UserSchema } from "../schemas/api_schemas";
import type { TGlobalEnv } from "../types/IRouters";

const userRouter = new Hono<TGlobalEnv>();

const UpdateUserSchema = z.object({
  maxHeartRate: z.number().int().positive().max(250).nullable().optional(),
  processHeartRate: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

userRouter.get(
  "/",
  describeRoute({
    description: "Get the authenticated user's profile and consent settings",
    responses: {
      200: {
        description: "User profile",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
      404: {
        description: "User not found",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  async (c) => {
    const user = await userController.getProfile(c.env.db, c.get("userId"));
    return c.json(user);
  },
);

userRouter.post(
  "/accept-privacy-policy",
  describeRoute({
    description:
      "Record the authenticated user's acceptance of the current privacy policy version.",
    responses: {
      200: {
        description: "Acceptance recorded",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
    },
  }),
  async (c) => {
    const user = await userController.acceptPrivacyPolicy(c.env.db, c.get("userId"));
    return c.json(user);
  },
);

userRouter.post(
  "/accept-terms-of-service",
  describeRoute({
    description:
      "Record the authenticated user's acceptance of the current terms of service version.",
    responses: {
      200: {
        description: "Acceptance recorded",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
    },
  }),
  async (c) => {
    const user = await userController.acceptTermsOfService(c.env.db, c.get("userId"));
    return c.json(user);
  },
);

userRouter.patch(
  "/",
  describeRoute({
    description:
      "Update the authenticated user's settings. processHeartRate is the GDPR Art 9 consent toggle for heart-rate processing.",
    responses: {
      200: {
        description: "Updated user profile",
        content: { "application/json": { schema: resolver(UserSchema) } },
      },
      400: {
        description: "Invalid body",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("json", UpdateUserSchema),
  async (c) => {
    const user = await userController.updateSettings(
      c.env.db,
      c.get("userId"),
      c.req.valid("json"),
    );
    return c.json(user);
  },
);

userRouter.delete(
  "/data",
  describeRoute({
    description:
      "Permanently delete the authenticated user's account: removes all activities (interval segments cascade), the user row, revokes Strava OAuth, and clears Clerk metadata.",
    responses: {
      200: {
        description: "All user data deleted",
        content: { "application/json": { schema: resolver(DeleteAccountResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const result = await userController.deleteAccount(c.env.db, c.get("userId"));
    return c.json(result);
  },
);

export default userRouter;
