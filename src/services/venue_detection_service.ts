import { SIGNATURE_VENUES } from "../agent/running_venues";
import type { LatLng, StreamSet } from "../types/strava/IStream";
import type { VenueContext } from "./interval_structure_service";

const SAMPLE_LIMIT = 200;
const MIN_INSIDE_FRACTION = 0.3;

const toRad = (deg: number) => (deg * Math.PI) / 180;

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function samplePoints(points: LatLng[]): LatLng[] {
  const valid = points.filter((p) => Array.isArray(p) && (p[0] !== 0 || p[1] !== 0));
  if (valid.length <= SAMPLE_LIMIT) return valid;
  const step = Math.ceil(valid.length / SAMPLE_LIMIT);
  const out: LatLng[] = [];
  for (let i = 0; i < valid.length; i += step) out.push(valid[i]);
  return out;
}

export function resolveVenueContext(streams: StreamSet | null | undefined): VenueContext {
  const points = streams?.latlng?.data;
  if (!points || points.length === 0) return { confirmedTokens: [], hasGps: false };

  const sampled = samplePoints(points);
  if (sampled.length === 0) return { confirmedTokens: [], hasGps: false };

  const confirmedTokens: string[] = [];
  for (const v of SIGNATURE_VENUES) {
    if (v.lat == null || v.lng == null || v.radiusMeters == null) continue;
    const center: LatLng = [v.lat, v.lng];
    const radius = v.radiusMeters;
    const inside = sampled.filter((p) => haversineMeters(p, center) <= radius).length;
    if (inside / sampled.length >= MIN_INSIDE_FRACTION) confirmedTokens.push(v.token);
  }
  return { confirmedTokens, hasGps: true };
}
