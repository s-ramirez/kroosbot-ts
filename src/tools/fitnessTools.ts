import type { FitnessStore } from "../fitness/store.js";
import type { Tool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { optionalString, requiredString } from "./shared.js";

export function createFitnessTools(fitness: FitnessStore): Tool[] {
  return [
    new SetFitnessProfileTool(fitness),
    new GetFitnessProfileTool(fitness),
    new LogMealTool(fitness),
    new GetDailyNutritionTool(fitness),
    new GetMissingMealsTool(fitness)
  ];
}

class SetFitnessProfileTool implements Tool {
  readonly definition = {
    name: "set_fitness_profile",
    description: "Set durable fitness preferences like calorie target, protein target, timezone, and expected meal names.",
    parameters: [
      {
        name: "calorie_target",
        type: "string" as const,
        description: "Optional daily calorie target as a number."
      },
      {
        name: "protein_target",
        type: "string" as const,
        description: "Optional daily protein target in grams."
      },
      {
        name: "timezone",
        type: "string" as const,
        description: "Optional IANA timezone like America/Chicago."
      },
      {
        name: "reminder_enabled",
        type: "string" as const,
        description: "Optional true or false."
      },
      {
        name: "meal_names",
        type: "string" as const,
        description: "Optional comma-separated meal names like breakfast,lunch,dinner,snack."
      }
    ]
  };

  constructor(private readonly fitness: FitnessStore) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const mealNames = optionalString(args.meal_names)
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const profile = await this.fitness.setProfile({
      calorieTarget: parseOptionalNumber(optionalString(args.calorie_target), "calorie_target"),
      proteinTarget: parseOptionalNumber(optionalString(args.protein_target), "protein_target"),
      timezone: optionalString(args.timezone),
      reminderEnabled: parseOptionalBoolean(optionalString(args.reminder_enabled), "reminder_enabled"),
      mealNames
    });
    return {
      ok: true,
      content: [
        "Updated fitness profile.",
        `timezone: ${profile.timezone}`,
        `calorie_target: ${profile.calorieTarget ?? "(none)"}`,
        `protein_target: ${profile.proteinTarget ?? "(none)"}`,
        `reminder_enabled: ${profile.reminderEnabled ? "true" : "false"}`,
        `meal_names: ${profile.mealNames.join(", ")}`
      ].join("\n")
    };
  }
}

class GetFitnessProfileTool implements Tool {
  readonly definition = {
    name: "get_fitness_profile",
    description: "Read the saved fitness profile and defaults for meal tracking.",
    parameters: []
  };

  constructor(private readonly fitness: FitnessStore) {}

  async execute(_args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const profile = await this.fitness.getProfile();
    return {
      ok: true,
      content: [
        `timezone: ${profile.timezone}`,
        `calorie_target: ${profile.calorieTarget ?? "(none)"}`,
        `protein_target: ${profile.proteinTarget ?? "(none)"}`,
        `reminder_enabled: ${profile.reminderEnabled ? "true" : "false"}`,
        `meal_names: ${profile.mealNames.join(", ")}`
      ].join("\n")
    };
  }
}

class LogMealTool implements Tool {
  readonly definition = {
    name: "log_meal",
    description: "Record a meal in the structured fitness log for a specific date or for today by default.",
    parameters: [
      {
        name: "meal",
        type: "string" as const,
        description: "Meal name like breakfast, lunch, dinner, or snack.",
        required: true
      },
      {
        name: "description",
        type: "string" as const,
        description: "What was eaten.",
        required: true
      },
      {
        name: "calories",
        type: "string" as const,
        description: "Estimated or confirmed calories as a number.",
        required: true
      },
      {
        name: "protein_grams",
        type: "string" as const,
        description: "Optional protein in grams."
      },
      {
        name: "date",
        type: "string" as const,
        description: "Optional date in YYYY-MM-DD. Defaults to today in the configured timezone."
      },
      {
        name: "estimated",
        type: "string" as const,
        description: "Optional true or false. Use true when calories are approximate."
      }
    ]
  };

  constructor(private readonly fitness: FitnessStore) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const result = await this.fitness.logMeal({
      meal: requiredString(args.meal, "meal"),
      description: requiredString(args.description, "description"),
      calories: parseRequiredNumber(requiredString(args.calories, "calories"), "calories"),
      proteinGrams: parseOptionalNumber(optionalString(args.protein_grams), "protein_grams"),
      date: optionalString(args.date),
      estimated: parseOptionalBoolean(optionalString(args.estimated), "estimated")
    });
    return {
      ok: true,
      content: [
        `Logged ${result.entry.meal} for ${result.log.date}.`,
        `description: ${result.entry.description}`,
        `calories: ${result.entry.calories}`,
        `protein_grams: ${result.entry.proteinGrams ?? "(none)"}`,
        `estimated: ${result.entry.estimated ? "true" : "false"}`
      ].join("\n")
    };
  }
}

class GetDailyNutritionTool implements Tool {
  readonly definition = {
    name: "get_daily_nutrition",
    description: "Summarize meals, totals, targets, and missing meals for a day.",
    parameters: [
      {
        name: "date",
        type: "string" as const,
        description: "Optional date in YYYY-MM-DD. Defaults to today."
      }
    ]
  };

  constructor(private readonly fitness: FitnessStore) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const summary = await this.fitness.getDailyNutrition(optionalString(args.date));
    const mealLines = summary.meals.length === 0
      ? ["meals: none logged yet"]
      : summary.meals.map((meal, index) => [
          `${index + 1}. ${meal.meal}`,
          `description: ${meal.description}`,
          `calories: ${meal.calories}`,
          `protein_grams: ${meal.proteinGrams ?? "(none)"}`,
          `estimated: ${meal.estimated ? "true" : "false"}`
        ].join(" | "));
    return {
      ok: true,
      content: [
        `date: ${summary.date}`,
        `timezone: ${summary.timezone}`,
        `total_calories: ${summary.totalCalories}`,
        `total_protein_grams: ${summary.totalProteinGrams}`,
        `calorie_target: ${summary.calorieTarget ?? "(none)"}`,
        `protein_target: ${summary.proteinTarget ?? "(none)"}`,
        `missing_meals: ${summary.missingMeals.length > 0 ? summary.missingMeals.join(", ") : "(none)"}`,
        ...mealLines
      ].join("\n")
    };
  }
}

class GetMissingMealsTool implements Tool {
  readonly definition = {
    name: "get_missing_meals",
    description: "Return which expected meals have not been logged yet for a day.",
    parameters: [
      {
        name: "date",
        type: "string" as const,
        description: "Optional date in YYYY-MM-DD. Defaults to today."
      }
    ]
  };

  constructor(private readonly fitness: FitnessStore) {}

  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const date = optionalString(args.date);
    const missingMeals = await this.fitness.getMissingMeals(date);
    return {
      ok: true,
      content: missingMeals.length > 0 ? missingMeals.join(", ") : "(none)"
    };
  }
}

function parseRequiredNumber(value: string, fieldName: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
  return parsed;
}

function parseOptionalNumber(value: string | undefined, fieldName: string): number | undefined {
  if (!value) return undefined;
  return parseRequiredNumber(value, fieldName);
}

function parseOptionalBoolean(value: string | undefined, fieldName: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${fieldName} must be true or false`);
}
