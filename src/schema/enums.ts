
import {  pgEnum, } from 'drizzle-orm/pg-core';
export const trainingTypeEnum = pgEnum('training_type', [
  'LONG_RUN',
  'EASY_RUN',
  'SHORT_INTERVALS',
  'HILL_SPRINTS',
  'LONG_INTERVALS',
  'SPRINTS',
  'FARTLEK',
  'PROGRESSIVE_LONG_RUN',
  'RACE',
  'TEMPO',
  'RECOVERY',
  'OTHER'
]);