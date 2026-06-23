export type RunningVenue = {
  name: string;
  meters: number;
  aliases: string[];
  exact: boolean;
};

export const RUNNING_VENUES: RunningVenue[] = [
  {
    name: "Bislett",
    meters: 546.5,
    aliases: ["bislett", "bislett runde", "bislettrunde", "bunkern", "indoor bislett"],
    exact: true,
  },
  {
    name: "Nordre gravlund",
    meters: 1500,
    aliases: ["nordre gravlund", "ng"],
    exact: false,
  },
  {
    name: "Voldsløkka",
    meters: 1000,
    aliases: ["voldsløkka", "voldslokka"],
    exact: false,
  },
];

export function venuePromptBlock(): string {
  const rows = RUNNING_VENUES.map((v) => {
    const dist = v.exact ? `${v.meters} m` : `~${v.meters} m`;
    return `  - **${v.name}** (aliases: ${v.aliases.join(", ")}) → ${dist} per round`;
  }).join("\n");

  return `### NAMED RUNNING VENUES (round lengths)
Some workouts name a venue and a rep count instead of a distance. Resolve these (case-insensitive, including the Norwegian spellings) to a per-rep distance:
${rows}

- "N × <venue>" or "N runder <venue>" ("runde"/"runder" = round/lap) means N work reps of that venue's round length (e.g. "6 × Voldsløkka" → 6 reps of 1000 m, "4 runder NG" → 4 reps of 1500 m, "10 × bunkern" → 10 reps of 546.5 m).
- Treat the venue length as the work distance unless the text states otherwise.
- When explicit lap distances are present, use these lengths to sanity-check them (a Bislett loop should read ~546.5 m, not 500 m).`;
}
