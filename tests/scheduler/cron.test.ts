import { describe, expect, test } from "bun:test";
import { nextCronOccurrence, parseCronExpression } from "../../src/scheduler/cron.js";

describe("scheduler cron", () => {
  test("parses ranges, lists, and steps", () => {
    const parsed = parseCronExpression("*/15 9-17 1,15 1-6 1,3,5");
    expect(parsed.minute.values.has(0)).toBe(true);
    expect(parsed.minute.values.has(15)).toBe(true);
    expect(parsed.minute.values.has(30)).toBe(true);
    expect(parsed.minute.values.has(45)).toBe(true);
    expect(parsed.hour.values.has(9)).toBe(true);
    expect(parsed.hour.values.has(17)).toBe(true);
    expect(parsed.dayOfMonth.values.has(1)).toBe(true);
    expect(parsed.dayOfMonth.values.has(15)).toBe(true);
    expect(parsed.month.values.has(6)).toBe(true);
    expect(parsed.dayOfWeek.values.has(5)).toBe(true);
  });

  test("normalizes sunday 7 to 0", () => {
    const parsed = parseCronExpression("0 12 * * 7");
    expect(parsed.dayOfWeek.values.has(0)).toBe(true);
    expect(parsed.dayOfWeek.values.has(7)).toBe(false);
  });

  test("computes the next matching occurrence", () => {
    const parsed = parseCronExpression("*/5 * * * *");
    const next = nextCronOccurrence(parsed, new Date("2026-03-26T10:02:00Z"));
    expect(next?.toISOString()).toBe("2026-03-26T10:05:00.000Z");
  });

  test("uses cron day-of-month/day-of-week semantics", () => {
    const parsed = parseCronExpression("0 9 15 * 1");
    const next = nextCronOccurrence(parsed, new Date("2026-03-16T08:00:00Z"));
    expect(next?.toISOString()).toBe("2026-03-16T09:00:00.000Z");
  });

  test("rejects invalid expressions", () => {
    expect(() => parseCronExpression("* * *")).toThrow("Cron expression must have 5 fields");
    expect(() => parseCronExpression("61 * * * *")).toThrow("out of range");
    expect(() => parseCronExpression("*/0 * * * *")).toThrow("Invalid cron step");
  });
});
