import { resolver } from "hono-openapi";
import type { ZodType } from "zod";
import { ErrorSchema } from "./api_schemas";

export const okJson = (schema: ZodType, description: string) => ({
  description,
  content: { "application/json": { schema: resolver(schema) } },
});

export const errJson = (description: string) => ({
  description,
  content: { "application/json": { schema: resolver(ErrorSchema) } },
});
