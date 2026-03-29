export type FitnessConfig = {
  enabled: boolean;
  rootDir: string;
  defaultTimezone: string;
};

export type FitnessProfile = {
  timezone: string;
  calorieTarget?: number;
  proteinTarget?: number;
  reminderEnabled: boolean;
  mealNames: string[];
};

export type MealEntry = {
  id: string;
  meal: string;
  description: string;
  calories: number;
  proteinGrams?: number;
  estimated: boolean;
  loggedAt: string;
};

export type DailyFitnessLog = {
  date: string;
  timezone: string;
  meals: MealEntry[];
};

export type DailyNutritionSummary = {
  date: string;
  timezone: string;
  meals: MealEntry[];
  totalCalories: number;
  totalProteinGrams: number;
  calorieTarget?: number;
  proteinTarget?: number;
  reminderEnabled: boolean;
  missingMeals: string[];
};
