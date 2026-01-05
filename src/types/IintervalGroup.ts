export interface ProposedIntervalSegment {
  targetValue: number|null;
  unit: string;
  proposedPace: number|null;
}

export interface IntervalGroup {
  groupId: number;
  items: ProposedIntervalSegment[];
  restValue: number | null;
}