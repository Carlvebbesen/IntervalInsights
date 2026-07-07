import { resolver } from "hono-openapi";
import type { ZodType } from "zod";
import { ErrorSchema } from "./api_schemas";

/** describeRoute response entry for a JSON success body. */
export const okJson = (schema: ZodType, description: string) => ({
  description,
  content: { "application/json": { schema: resolver(schema) } },
});

/** describeRoute response entry for the standard `{ error }` envelope. */
export const errJson = (description: string) => ({
  description,
  content: { "application/json": { schema: resolver(ErrorSchema) } },
});
