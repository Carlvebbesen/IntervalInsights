/**
 * Structure-extraction rules shared verbatim by the analyze classifier
 * (`initial_analysis_agent.ts`) and the free-text parse agent
 * (`parse_intervals_agent.ts`). Both emit the same `workoutSet[]` shape, so the
 * Set/Step/rep-count rules — including the hard-won Norwegian comma-list,
 * "N x (a,b,c)", and compound-block fixes — must live in exactly one place.
 * Callers may append their own agent-specific rules after this block.
 */
export const STRUCTURE_EXTRACTION_RULES = `1. **Identify Repeating Series:** For a simple workout like **10x1000m**: create one Set with **set_reps: 1** and one Step with **reps: 10**. For a complex workout like **3x (3km + 2km + 1km)**: create one Set with **set_reps: 3** and, inside that set, three Steps (3000m, 2000m, 1000m) each with **reps: 1**.
2. **Units:** Always convert distance to METERS and time to SECONDS.
3. **Comma-separated values are a STEP LIST, not decimals (Norwegian list notation):** "3,2,1 km" = three Steps of 3 km, 2 km, 1 km (→ 3000m, 2000m, 1000m); "2 x 3,2,2 km" = one Set with **set_reps: 2** and three Steps (3000m, 2000m, 2000m). A comma between numbers in such a list is a SEPARATOR, never a decimal point.
4. **"N x (a, b, c)" = N SETS of the sequence a→b→c.** Set **set_reps: N** and create ONE Step per item (reps: 1 each), so the sequence repeats a,b,c / a,b,c / … — e.g. **"5 x (3,2,1 min)"** = set_reps: 5, Steps [180s, 120s, 60s] each reps: 1; **"3x (3km + 2km + 1km)"** = set_reps: 3, Steps [3000m, 2000m, 1000m]. **Do NOT** create 3 Steps with reps: N (that wrongly groups all the a's, then all the b's, then all the c's).
5. **Compound / sequential workouts = ONE Set PER BLOCK — capture EVERY block.** When the workout chains distinct interval blocks, emit a SEPARATE Set for each block in order, and never drop the trailing block(s). Triggers include English "X followed by Y", "X then Y", and Norwegian "X etterfulgt av Y", "X deretter Y", "X så Y", or a top-level "X + Y" joining two different rep schemes. E.g. **"4x1000m etterfulgt av 20x45/15"** = TWO Sets: Set 1 (set_reps: 1, one Step reps: 4, DISTANCE 1000m) and Set 2 (set_reps: 1, one Step reps: 20, TIME 45s work / 15s recovery). (Distinguish from rule 4's "N x (a,b,c)", which is ONE block repeated.)
6. **Recovery placement:** Recovery between reps goes on the Step (recovery_value). A distinct longer break between sets (e.g. 5 mins between blocks of intervals) goes on the Set (set_recovery).
7. **Ignore Warmup/Cooldown:** Only capture the "work" segments.`;
