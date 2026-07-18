import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import fixture from "../../tests/fixtures/met_locationforecast_complete.json";
import {
  clearWeatherCache,
  fetchCurrentWeather,
  type MetForecastResponse,
  mapMetForecastToWeather,
} from "./weather_service";

function metResponse(
  body: unknown,
  opts: { status?: number; expires?: string; lastModified?: string } = {},
): Response {
  const headers = new Headers();
  if (opts.expires) headers.set("Expires", opts.expires);
  if (opts.lastModified) headers.set("Last-Modified", opts.lastModified);
  const status = opts.status ?? 200;
  const nullBody = status === 304 || status === 204;
  return new Response(nullBody ? null : JSON.stringify(body), { status, headers });
}

describe("mapMetForecastToWeather", () => {
  test("maps the first timeseries entry from the real fixture", () => {
    const w = mapMetForecastToWeather(fixture as MetForecastResponse);
    expect(w).not.toBeNull();
    expect(w?.temperatureC).toBe(12.9);
    expect(w?.humidity).toBe(68.5);
    expect(w?.cloudCover).toBeCloseTo(0.918, 5); // 91.8 / 100
    expect(w?.windKph).toBeCloseTo(10.44, 5); // 2.9 * 3.6
    expect(w?.uvIndex).toBe(1.8); // ultraviolet_index_clear_sky passthrough
    expect(w?.condition).toBe("cloudy"); // next_1_hours.summary.symbol_code
    expect(w?.apparentTemperatureC).toBeUndefined(); // MET provides none
  });

  test("falls back to next_6_hours symbol_code when next_1_hours is missing", () => {
    const body: MetForecastResponse = {
      properties: {
        timeseries: [
          {
            data: {
              instant: { details: { air_temperature: 5, relative_humidity: 80 } },
              next_6_hours: { summary: { symbol_code: "partlycloudy_day" } },
            },
          },
        ],
      },
    };
    expect(mapMetForecastToWeather(body)?.condition).toBe("partlycloudy_day");
  });

  test("omits optional fields when the source values are missing", () => {
    const body: MetForecastResponse = {
      properties: {
        timeseries: [
          { data: { instant: { details: { air_temperature: 5, relative_humidity: 80 } } } },
        ],
      },
    };
    const w = mapMetForecastToWeather(body);
    expect(w).toEqual({ temperatureC: 5, humidity: 80 });
    expect(w).not.toHaveProperty("cloudCover");
    expect(w).not.toHaveProperty("windKph");
    expect(w).not.toHaveProperty("uvIndex");
    expect(w).not.toHaveProperty("condition");
  });

  test("returns null when required temperature/humidity are absent", () => {
    expect(mapMetForecastToWeather({ properties: { timeseries: [] } })).toBeNull();
    expect(
      mapMetForecastToWeather({
        properties: { timeseries: [{ data: { instant: { details: {} } } }] },
      }),
    ).toBeNull();
  });
});

describe("fetchCurrentWeather", () => {
  const futureExpires = new Date(Date.now() + 3600_000).toUTCString();

  beforeEach(() => {
    clearWeatherCache();
    setSystemTime();
  });

  test("caches within Expires — a second call does not hit upstream", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return metResponse(fixture, { expires: futureExpires });
    };

    const first = await fetchCurrentWeather(63.43, 10.4, undefined, fetchImpl);
    const second = await fetchCurrentWeather(63.43, 10.4, undefined, fetchImpl);

    expect(first?.temperatureC).toBe(12.9);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  test("rounds coords to 2 decimals so near-identical points share a cache entry", async () => {
    let calls = 0;
    const fetchImpl = async (input: string | URL) => {
      calls++;
      const url = new URL(input);
      expect(url.searchParams.get("lat")).toBe("63.43");
      expect(url.searchParams.get("lon")).toBe("10.4");
      return metResponse(fixture, { expires: futureExpires });
    };

    await fetchCurrentWeather(63.4312, 10.4009, undefined, fetchImpl);
    await fetchCurrentWeather(63.4288, 10.3951, undefined, fetchImpl);
    expect(calls).toBe(1);
  });

  test("revalidates after expiry and keeps the cached body on 304", async () => {
    const t0 = new Date("2026-07-18T07:00:00Z").getTime();
    setSystemTime(t0);

    const lastModified = "Sat, 18 Jul 2026 06:58:00 GMT";
    let calls = 0;
    let sawIfModifiedSince = false;
    const fetchImpl = async (_input: string | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return metResponse(fixture, {
          expires: new Date(t0 - 1000).toUTCString(), // past → TTL floored to +10min
          lastModified,
        });
      }
      const headers = new Headers(init?.headers);
      if (headers.get("If-Modified-Since") === lastModified) sawIfModifiedSince = true;
      return metResponse(null, { status: 304, expires: new Date(t0 + 20 * 60_000).toUTCString() });
    };

    const first = await fetchCurrentWeather(63.43, 10.4, undefined, fetchImpl);
    setSystemTime(t0 + 11 * 60_000); // past the floored 10-min TTL
    const second = await fetchCurrentWeather(63.43, 10.4, undefined, fetchImpl);

    expect(calls).toBe(2);
    expect(sawIfModifiedSince).toBe(true);
    expect(second).toEqual(first);
  });

  test("returns null on a 403 upstream response", async () => {
    const fetchImpl = async () => metResponse(null, { status: 403 });
    expect(await fetchCurrentWeather(63.43, 10.4, undefined, fetchImpl)).toBeNull();
  });

  test("returns null when the request times out / throws", async () => {
    const fetchImpl = async () => {
      throw new DOMException("timed out", "TimeoutError");
    };
    expect(await fetchCurrentWeather(63.43, 10.4, undefined, fetchImpl)).toBeNull();
  });
});
