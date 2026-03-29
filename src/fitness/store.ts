import fs from "node:fs/promises";
import path from "node:path";
import type { FitnessConfig, FitnessProfile, DailyFitnessLog, DailyNutritionSummary, MealEntry } from "./types.js";

const DEFAULT_MEAL_NAMES = ["breakfast", "lunch", "dinner"];

export class FitnessStore {
  private readonly rootDir: string;
  private readonly daysDir: string;
  private readonly profilePath: string;

  constructor(private readonly config: FitnessConfig) {
    this.rootDir = path.resolve(config.rootDir);
    this.daysDir = path.join(this.rootDir, "days");
    this.profilePath = path.join(this.rootDir, "profile.json");
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    await fs.mkdir(this.daysDir, { recursive: true });
  }

  async getProfile(): Promise<FitnessProfile> {
    if (!this.enabled) {
      throw new Error("fitness tracking is disabled");
    }

    const raw = await fs.readFile(this.profilePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return this.defaultProfile();
    }

    const parsed = JSON.parse(raw) as Partial<FitnessProfile>;
    return sanitizeProfile({
      ...this.defaultProfile(),
      ...parsed
    }, this.config.defaultTimezone);
  }

  async setProfile(input: Partial<FitnessProfile>): Promise<FitnessProfile> {
    if (!this.enabled) {
      throw new Error("fitness tracking is disabled");
    }

    const current = await this.getProfile();
    const next = sanitizeProfile({
      ...current,
      ...input
    }, this.config.defaultTimezone);
    await this.writeJson(this.profilePath, next);
    return next;
  }

  async logMeal(input: {
    meal: string;
    description: string;
    calories: number;
    proteinGrams?: number;
    date?: string;
    estimated?: boolean;
  }): Promise<{ log: DailyFitnessLog; entry: MealEntry }> {
    if (!this.enabled) {
      throw new Error("fitness tracking is disabled");
    }

    const profile = await this.getProfile();
    const timezone = profile.timezone;
    const date = normalizeDate(input.date) ?? formatDateInTimeZone(new Date(), timezone);
    const log = await this.readDayLog(date, timezone);
    const entry: MealEntry = {
      id: crypto.randomUUID(),
      meal: normalizeMealName(input.meal),
      description: input.description.trim(),
      calories: roundNumber(input.calories),
      proteinGrams: input.proteinGrams === undefined ? undefined : roundNumber(input.proteinGrams),
      estimated: input.estimated ?? false,
      loggedAt: new Date().toISOString()
    };
    log.meals.push(entry);
    log.meals.sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
    await this.writeDayLog(log);
    return { log, entry };
  }

  async getDailyNutrition(date?: string): Promise<DailyNutritionSummary> {
    if (!this.enabled) {
      throw new Error("fitness tracking is disabled");
    }

    const profile = await this.getProfile();
    const resolvedDate = normalizeDate(date) ?? formatDateInTimeZone(new Date(), profile.timezone);
    const log = await this.readDayLog(resolvedDate, profile.timezone);
    const totalCalories = roundNumber(log.meals.reduce((sum, meal) => sum + meal.calories, 0));
    const totalProteinGrams = roundNumber(log.meals.reduce((sum, meal) => sum + (meal.proteinGrams ?? 0), 0));
    const loggedMeals = new Set(log.meals.map((meal) => normalizeMealName(meal.meal)));
    const mealNames = profile.mealNames.map((meal) => normalizeMealName(meal));

    return {
      date: log.date,
      timezone: log.timezone,
      meals: [...log.meals],
      totalCalories,
      totalProteinGrams,
      calorieTarget: profile.calorieTarget,
      proteinTarget: profile.proteinTarget,
      reminderEnabled: profile.reminderEnabled,
      missingMeals: mealNames.filter((meal) => !loggedMeals.has(meal))
    };
  }

  async getMissingMeals(date?: string): Promise<string[]> {
    const summary = await this.getDailyNutrition(date);
    return summary.missingMeals;
  }

  private async readDayLog(date: string, timezone: string): Promise<DailyFitnessLog> {
    const normalizedDate = normalizeDate(date);
    if (!normalizedDate) {
      throw new Error(`Invalid date: ${date}`);
    }
    const filePath = path.join(this.daysDir, `${normalizedDate}.json`);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      return {
        date: normalizedDate,
        timezone,
        meals: []
      };
    }

    const parsed = JSON.parse(raw) as Partial<DailyFitnessLog>;
    return {
      date: normalizeDate(parsed.date) ?? normalizedDate,
      timezone: typeof parsed.timezone === "string" && parsed.timezone.trim() ? parsed.timezone.trim() : timezone,
      meals: Array.isArray(parsed.meals)
        ? parsed.meals
            .map((meal) => sanitizeMealEntry(meal))
            .filter((meal): meal is MealEntry => meal !== null)
        : []
    };
  }

  private async writeDayLog(log: DailyFitnessLog): Promise<void> {
    await this.writeJson(path.join(this.daysDir, `${log.date}.json`), log);
  }

  private async writeJson(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private defaultProfile(): FitnessProfile {
    return {
      timezone: this.config.defaultTimezone,
      reminderEnabled: true,
      mealNames: [...DEFAULT_MEAL_NAMES]
    };
  }
}

function sanitizeProfile(profile: Partial<FitnessProfile>, defaultTimezone: string): FitnessProfile {
  const timezone = validateTimeZone(profile.timezone) ? profile.timezone!.trim() : defaultTimezone;
  const mealNames = uniqueStrings(Array.isArray(profile.mealNames) ? profile.mealNames : DEFAULT_MEAL_NAMES)
    .map(normalizeMealName);

  return {
    timezone,
    calorieTarget: normalizePositiveNumber(profile.calorieTarget),
    proteinTarget: normalizePositiveNumber(profile.proteinTarget),
    reminderEnabled: profile.reminderEnabled !== false,
    mealNames: mealNames.length > 0 ? mealNames : [...DEFAULT_MEAL_NAMES]
  };
}

function sanitizeMealEntry(value: unknown): MealEntry | null {
  if (!value || typeof value !== "object") return null;
  const meal = asString((value as Record<string, unknown>).meal);
  const description = asString((value as Record<string, unknown>).description);
  const loggedAt = asString((value as Record<string, unknown>).loggedAt);
  const id = asString((value as Record<string, unknown>).id);
  const calories = normalizePositiveNumber((value as Record<string, unknown>).calories);
  if (!meal || !description || !loggedAt || !id || calories === undefined) {
    return null;
  }

  return {
    id,
    meal: normalizeMealName(meal),
    description,
    calories,
    proteinGrams: normalizePositiveNumber((value as Record<string, unknown>).proteinGrams),
    estimated: Boolean((value as Record<string, unknown>).estimated),
    loggedAt
  };
}

function validateTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return roundNumber(value);
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeMealName(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
