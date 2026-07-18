import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { ErrorSchema, WeatherSchema } from "../schemas/api_schemas";
import { fetchCurrentWeather } from "../services/weather_service";
import type { TGlobalEnv } from "../types/IRouters";

const weatherRouter = new Hono<TGlobalEnv>();

const WeatherQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  altitude: z.coerce.number().int().optional(),
});

const WeatherCurrentResponseSchema = z
  .object({ weather: WeatherSchema.nullable() })
  .openapi({ ref: "WeatherCurrentResponse" });

weatherRouter.get(
  "/current",
  describeRoute({
    description:
      "Current weather for a device location via the MET Norway Locationforecast proxy. Pass `lat`/`lon` (and optional `altitude` in metres). Weather is always optional downstream: any upstream failure (throttle, deprecation, network/timeout) returns `{ weather: null }` with a 200, never a 5xx.",
    responses: {
      200: {
        description: "Current weather (or null when upstream is unavailable)",
        content: { "application/json": { schema: resolver(WeatherCurrentResponseSchema) } },
      },
      400: {
        description: "Invalid coordinates",
        content: { "application/json": { schema: resolver(ErrorSchema) } },
      },
    },
  }),
  validator("query", WeatherQuerySchema),
  async (c) => {
    const { lat, lon, altitude } = c.req.valid("query");
    const weather = await fetchCurrentWeather(lat, lon, altitude);
    return c.json({ weather });
  },
);

export default weatherRouter;
