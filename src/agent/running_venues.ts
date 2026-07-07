export type RunningVenue = {
  name: string;
  meters: number;
  aliases: string[];
  exact: boolean;
  // Signature token for exact venues that participate in structure-signature
  // snapping (see interval_structure_service canonicalization). Inexact venues
  // have no token — their measured laps just quantize to a plain distance.
  token?: string;
  // Geofence centre + radius for GPS venue confirmation (D4). Only exact venues
  // carry coordinates; the check confirms a distance snap, never overrides it.
  lat?: number;
  lng?: number;
  radiusMeters?: number;
};

export const RUNNING_VENUES: RunningVenue[] = [
  {
    name: "Bislett",
    meters: 546.5,
    aliases: ["bislett", "bislett runde", "bislettrunde", "bunkern", "indoor bislett"],
    exact: true,
    token: "BSL",
    lat: 59.925024,
    lng: 10.7334,
    radiusMeters: 180,
  },
  {
    name: "Nordre gravlund",
    meters: 1504.2,
    aliases: ["nordre gravlund", "ng"],
    exact: true,
    token: "NG",
    lat: 59.938758,
    lng: 10.74794,
    radiusMeters: 180,
  },
  {
    name: "Voldsløkka",
    meters: 1000,
    aliases: ["voldsløkka", "voldslokka"],
    exact: false,
  },
];

/** Exact venues that participate in signature snapping (have a token). */
export const SIGNATURE_VENUES = RUNNING_VENUES.filter(
  (v): v is RunningVenue & { token: string } => v.exact && v.token != null,
);

export function venuePromptBlock(): string {
  const rows = RUNNING_VENUES.map((v) => {
    const dist = v.exact ? `${v.meters} m` : `~${v.meters} m`;
    return `  - **${v.name}** (aliases: ${v.aliases.join(", ")}) → ${dist} per round`;
  }).join("\n");

  return `### NAMED RUNNING VENUES (round lengths)
Some workouts name a venue and a rep count instead of a distance. Resolve these (case-insensitive, including the Norwegian spellings) to a per-rep distance:
${rows}

- "N × <venue>" or "N runder <venue>" ("runde"/"runder" = round/lap) means N work reps of that venue's round length (e.g. "6 × Voldsløkka" → 6 reps of 1000 m, "4 runder NG" → 4 reps of 1504.2 m, "10 × bunkern" → 10 reps of 546.5 m).
- Treat the venue length as the work distance unless the text states otherwise.
- When explicit lap distances are present, use these lengths to sanity-check them (a Bislett loop should read ~546.5 m, not 500 m).`;
}
