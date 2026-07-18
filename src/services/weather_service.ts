import { logger } from "../logger";
import { tracedFetch } from "../otel";
import type { Weather } from "../schemas/api_schemas";

const MET_BASE_URL = "https://api.met.no/weatherapi/locationforecast/2.0/complete";
const USER_AGENT = "IntervalInsights/1.0 github.com/Carlvebbesen/IntervalInsights carl@taskctrl.no";
const FETCH_TIMEOUT_MS = 5000;
const MIN_TTL_MS = 10 * 60 * 1000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface MetInstantDetails {
  air_temperature?: number;
  relative_humidity?: number;
  cloud_area_fraction?: number;
  wind_speed?: number;
  ultraviolet_index_clear_sky?: number;
}

interface MetPeriodSummary {
  symbol_code?: string;
}

interface MetTimeseriesEntry {
  time?: string;
  data?: {
    instant?: { details?: MetInstantDetails };
    next_1_hours?: { summary?: MetPeriodSummary };
    next_6_hours?: { summary?: MetPeriodSummary };
  };
}

export interface MetForecastResponse {
  properties?: { timeseries?: MetTimeseriesEntry[] };
}

interface CacheEntry {
  value: Weather;
  expires: number;
  lastModified: string | null;
}

const cache = new Map<string, CacheEntry>();

export function clearWeatherCache(): void {
  cache.clear();
}

export function mapMetForecastToWeather(forecast: MetForecastResponse): Weather | null {
  const first = forecast.properties?.timeseries?.[0];
  const instant = first?.data?.instant?.details;
  if (!instant) return null;

  const { air_temperature, relative_humidity } = instant;
  if (typeof air_temperature !== "number" || typeof relative_humidity !== "number") return null;

  const weather: Weather = { temperatureC: air_temperature, humidity: relative_humidity };

  if (typeof instant.cloud_area_fraction === "number") {
    weather.cloudCover = instant.cloud_area_fraction / 100;
  }
  if (typeof instant.wind_speed === "number") {
    weather.windKph = instant.wind_speed * 3.6;
  }
  if (typeof instant.ultraviolet_index_clear_sky === "number") {
    weather.uvIndex = instant.ultraviolet_index_clear_sky;
  }
  const condition =
    first?.data?.next_1_hours?.summary?.symbol_code ??
    first?.data?.next_6_hours?.summary?.symbol_code;
  if (typeof condition === "string") weather.condition = condition;

  return weather;
}

function effectiveExpires(expiresHeader: string | null, now: number): number {
  const floor = now + MIN_TTL_MS;
  if (!expiresHeader) return floor;
  const parsed = Date.parse(expiresHeader);
  if (Number.isNaN(parsed)) return floor;
  return Math.max(parsed, floor);
}

export async function fetchCurrentWeather(
  lat: number,
  lon: number,
  altitude?: number,
  fetchImpl: FetchLike = tracedFetch,
): Promise<Weather | null> {
  const roundedLat = Math.round(lat * 100) / 100;
  const roundedLon = Math.round(lon * 100) / 100;
  const alt = altitude != null ? Math.round(altitude) : undefined;
  const key = alt != null ? `${roundedLat},${roundedLon},${alt}` : `${roundedLat},${roundedLon}`;

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now < cached.expires) return cached.value;

  const url = new URL(MET_BASE_URL);
  url.searchParams.set("lat", String(roundedLat));
  url.searchParams.set("lon", String(roundedLon));
  if (alt != null) url.searchParams.set("altitude", String(alt));

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err, lat: roundedLat, lon: roundedLon }, "MET locationforecast fetch failed");
    return null;
  }

  if (res.status === 304 && cached) {
    const entry: CacheEntry = {
      ...cached,
      expires: effectiveExpires(res.headers.get("expires"), now),
    };
    cache.set(key, entry);
    return cached.value;
  }

  if (!res.ok) {
    logger.warn(
      { status: res.status, lat: roundedLat, lon: roundedLon },
      "MET locationforecast non-ok response",
    );
    return null;
  }

  if (res.status === 203) {
    logger.warn(
      { lat: roundedLat, lon: roundedLon },
      "MET locationforecast endpoint deprecated (203)",
    );
  }

  let json: MetForecastResponse;
  try {
    json = (await res.json()) as MetForecastResponse;
  } catch (err) {
    logger.warn(
      { err, lat: roundedLat, lon: roundedLon },
      "MET locationforecast body parse failed",
    );
    return null;
  }

  const value = mapMetForecastToWeather(json);
  if (!value) return null;

  cache.set(key, {
    value,
    expires: effectiveExpires(res.headers.get("expires"), now),
    lastModified: res.headers.get("last-modified"),
  });
  return value;
}
