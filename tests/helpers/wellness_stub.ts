// Side-effect-free shared handle for driving the (real) intervals_wellness_service
// tests' wellness records. Lives in its own module so the test file can import
// it WITHOUT pulling in setup.fitness.ts's mock.module side effects (which would
// clobber the default suite's global mocks). See tests/setup.fitness.ts.

import type { IIntervalsWellness } from "../../src/types/intervals/IIntervalsWellness";

export const wellnessStub = {
  records: [] as Partial<IIntervalsWellness>[],
  reset() {
    this.records = [];
  },
};
