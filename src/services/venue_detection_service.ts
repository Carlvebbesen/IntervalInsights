import { SIGNATURE_VENUES } from "../agent/running_venues";
import type { LatLng, StreamSet } from "../types/strava/IStream";
import type { VenueContext } from "./interval_structure_service";

/**
 * GPS venue confirmation (D4 of signature-canonicalization). Resolves which
 * named venues an activity was performed at, from its latlng stream, so the
 * signature layer can snap a distance to that venue's token even when the
 * measured value looks like a clean prescription.
 *
 * This is a CONFIRMING signal only — it never forces a snap on its own. The
 * signature layer still requires the distance to be within the venue's
 * tolerance, so a coincidental pass through a geofence can't mislabel a
 * differently-sized rep (e.g. an outdoor 400 m track rep at Bislett is far
 * outside the 546.5 m tolerance and stays 400 m regardless of GPS).
 */

const SAMPLE_LIMIT = 200;
// Fraction of sampled GPS points that must fall inside a venue's geofence for
// it to count as "performed here". Generous because the geofence only permits
// an already-distance-plausible snap.
const MIN_INSIDE_FRACTION = 0.34;

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
  if (!points || points.length === 0) return { confirmedTokens: [] };

  const sampled = samplePoints(points);
  if (sampled.length === 0) return { confirmedTokens: [] };

  const confirmedTokens: string[] = [];
  for (const v of SIGNATURE_VENUES) {
    if (v.lat == null || v.lng == null || v.radiusMeters == null) continue;
    const center: LatLng = [v.lat, v.lng];
    const radius = v.radiusMeters;
    const inside = sampled.filter((p) => haversineMeters(p, center) <= radius).length;
    if (inside / sampled.length >= MIN_INSIDE_FRACTION) confirmedTokens.push(v.token);
  }
  return { confirmedTokens };
}
