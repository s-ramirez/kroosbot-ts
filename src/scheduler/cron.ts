type CronField = {
  readonly wildcard: boolean;
  readonly values: Set<number>;
};

export type ParsedCron = {
  readonly expression: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
};

export function parseCronExpression(expression: string): ParsedCron {
  const normalized = expression.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields. Received ${parts.length}.`);
  }

  return {
    expression: normalized,
    minute: parseCronField(parts[0] ?? "", 0, 59),
    hour: parseCronField(parts[1] ?? "", 0, 23),
    dayOfMonth: parseCronField(parts[2] ?? "", 1, 31),
    month: parseCronField(parts[3] ?? "", 1, 12),
    dayOfWeek: parseCronField(parts[4] ?? "", 0, 7, { normalizeDayOfWeek: true })
  };
}

export function nextCronOccurrence(parsed: ParsedCron, after: Date): Date | null {
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxIterations = 366 * 24 * 60 * 2;
  for (let i = 0; i < maxIterations; i += 1) {
    if (matchesCron(parsed, cursor)) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  return null;
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (!parsed.minute.values.has(minute)) return false;
  if (!parsed.hour.values.has(hour)) return false;
  if (!parsed.month.values.has(month)) return false;

  const dayOfMonthMatch = parsed.dayOfMonth.values.has(dayOfMonth);
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(dayOfWeek);

  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) {
    return true;
  }
  if (parsed.dayOfMonth.wildcard) {
    return dayOfWeekMatch;
  }
  if (parsed.dayOfWeek.wildcard) {
    return dayOfMonthMatch;
  }
  return dayOfMonthMatch || dayOfWeekMatch;
}

function parseCronField(
  raw: string,
  min: number,
  max: number,
  options?: { normalizeDayOfWeek?: boolean }
): CronField {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("Cron field cannot be empty.");
  }
  if (normalized === "*") {
    return {
      wildcard: true,
      values: new Set(range(min, max))
    };
  }

  const values = new Set<number>();
  for (const segment of normalized.split(",")) {
    expandCronSegment(segment.trim(), min, max, values, options);
  }
  if (values.size === 0) {
    throw new Error(`Cron field "${raw}" resolved to no values.`);
  }

  return {
    wildcard: false,
    values
  };
}

function expandCronSegment(
  rawSegment: string,
  min: number,
  max: number,
  target: Set<number>,
  options?: { normalizeDayOfWeek?: boolean }
): void {
  if (!rawSegment) {
    throw new Error("Cron field segment cannot be empty.");
  }

  const [rangePart, stepPart] = rawSegment.split("/");
  const step = stepPart ? parsePositiveInt(stepPart, rawSegment) : 1;
  if (step <= 0) {
    throw new Error(`Invalid cron step in "${rawSegment}".`);
  }

  if ((rangePart ?? "") === "*") {
    for (let value = min; value <= max; value += step) {
      target.add(normalizeCronValue(value, options));
    }
    return;
  }

  const [startRaw, endRaw] = (rangePart ?? "").split("-");
  if (endRaw !== undefined) {
    const start = parseCronValue(startRaw ?? "", min, max, rawSegment, options);
    const end = parseCronValue(endRaw, min, max, rawSegment, options);
    if (start > end) {
      throw new Error(`Invalid cron range "${rawSegment}".`);
    }
    for (let value = start; value <= end; value += step) {
      target.add(normalizeCronValue(value, options));
    }
    return;
  }

  const exact = parseCronValue(rangePart ?? "", min, max, rawSegment, options);
  target.add(normalizeCronValue(exact, options));
}

function parseCronValue(
  raw: string,
  min: number,
  max: number,
  context: string,
  options?: { normalizeDayOfWeek?: boolean }
): number {
  const value = parsePositiveInt(raw, context);
  if (value < min || value > max) {
    throw new Error(`Cron value "${raw}" is out of range for "${context}".`);
  }
  return value;
}

function normalizeCronValue(value: number, options?: { normalizeDayOfWeek?: boolean }): number {
  if (options?.normalizeDayOfWeek && value === 7) {
    return 0;
  }
  return value;
}

function parsePositiveInt(raw: string, context: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid integer "${raw}" in cron field "${context}".`);
  }
  return value;
}

function range(min: number, max: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value += 1) {
    values.push(value);
  }
  return values;
}
