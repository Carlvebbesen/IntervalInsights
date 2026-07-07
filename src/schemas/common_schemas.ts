import "zod-openapi/extend";
import { z } from "zod";

export const ErrorSchema = z.object({ error: z.string() }).openapi({ ref: "Error" });

// Shared weather snapshot (device-sourced, e.g. iOS WeatherKit). temperatureC +
// humidity are what the heat-pace model needs; the rest refine the estimate.
export const WeatherSchema = z
  .object({
    temperatureC: z.number(),
    humidity: z.number().describe("Relative humidity, %."),
    apparentTemperatureC: z.number().optional(),
    uvIndex: z.number().optional(),
    cloudCover: z.number().optional().describe("0..1 fraction."),
    windKph: z.number().optional(),
    condition: z.string().optional(),
  })
  .openapi({ ref: "Weather" });

export type Weather = z.infer<typeof WeatherSchema>;

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");
