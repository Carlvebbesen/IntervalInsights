import { describe, expect, it } from "bun:test";
import { type GearDefaultRow, planGearDefaultMoves } from "../scripts/_sigcanon_core";

const USER_A = "aaaaaaaa-0000-0000-0000-000000000000";
const USER_B = "bbbbbbbb-0000-0000-0000-000000000000";

const activity = (userId: string, oldStructureId: number, newSignature: string) => ({
  userId,
  oldStructureId,
  newSignature,
});

const pin = (userId: string, intervalStructureId: number, iso: string): GearDefaultRow => ({
  userId,
  intervalStructureId,
  createdAt: new Date(iso),
});

describe("planGearDefaultMoves", () => {
  it("follows the structure its owner's activities moved to", () => {
    const plan = planGearDefaultMoves(
      [activity(USER_A, 7, "5x1000"), activity(USER_A, 7, "5x1000")],
      [pin(USER_A, 7, "2026-01-01")],
    );

    expect(plan.stranded).toEqual([]);
    expect(plan.moves).toEqual([
      { userId: USER_A, fromStructureId: 7, targetSignature: "5x1000", action: "repoint" },
    ]);
  });

  it("resolves the target per user, not globally", () => {
    const plan = planGearDefaultMoves(
      [activity(USER_A, 7, "5x1000"), activity(USER_B, 7, "6x800")],
      [pin(USER_A, 7, "2026-01-01"), pin(USER_B, 7, "2026-01-01")],
    );

    expect(plan.moves.map((m) => m.targetSignature)).toEqual(["5x1000", "6x800"]);
  });

  it("takes the majority signature when a user's own activities disagree", () => {
    const plan = planGearDefaultMoves(
      [
        activity(USER_A, 7, "5x1000"),
        activity(USER_A, 7, "6x800"),
        activity(USER_A, 7, "6x800"),
      ],
      [pin(USER_A, 7, "2026-01-01")],
    );

    expect(plan.moves[0].targetSignature).toBe("6x800");
  });

  it("keeps the newer pin when two of a user's defaults collapse onto one structure", () => {
    const plan = planGearDefaultMoves(
      [activity(USER_A, 7, "5x1000"), activity(USER_A, 9, "5x1000")],
      [pin(USER_A, 7, "2026-01-01"), pin(USER_A, 9, "2026-06-01")],
    );

    expect(plan.moves).toEqual([
      { userId: USER_A, fromStructureId: 7, targetSignature: "5x1000", action: "drop" },
      { userId: USER_A, fromStructureId: 9, targetSignature: "5x1000", action: "repoint" },
    ]);
  });

  it("does not let one user's collision drop another user's pin", () => {
    const plan = planGearDefaultMoves(
      [activity(USER_A, 7, "5x1000"), activity(USER_A, 9, "5x1000"), activity(USER_B, 9, "5x1000")],
      [pin(USER_A, 7, "2026-01-01"), pin(USER_A, 9, "2026-06-01"), pin(USER_B, 9, "2026-01-01")],
    );

    expect(plan.moves.filter((m) => m.action === "drop")).toHaveLength(1);
    expect(plan.moves.find((m) => m.userId === USER_B)?.action).toBe("repoint");
  });

  it("strands a pin whose owner has no activity under that structure", () => {
    const plan = planGearDefaultMoves([activity(USER_B, 7, "5x1000")], [pin(USER_A, 7, "2026-01-01")]);

    expect(plan.moves).toEqual([]);
    expect(plan.stranded).toEqual([pin(USER_A, 7, "2026-01-01")]);
  });

  it("is stable regardless of row order", () => {
    const plans = [activity(USER_A, 7, "b"), activity(USER_A, 7, "a")];
    const defaults = [pin(USER_A, 7, "2026-01-01")];

    expect(planGearDefaultMoves(plans, defaults).moves[0].targetSignature).toBe(
      planGearDefaultMoves([...plans].reverse(), defaults).moves[0].targetSignature,
    );
  });
});
