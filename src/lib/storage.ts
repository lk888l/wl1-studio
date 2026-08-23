import { parameterDefinitions } from "../data/parameters";
import type { ParameterProfile, ParameterValues, PersonalizationSettings } from "../types";

const PROFILE_KEY = "wl1-studio.parameter-profiles.v1";
const PERSONALIZATION_KEY = "wl1-studio.personalization.v1";

export const defaultPersonalization: PersonalizationSettings = {
  accent: "azure",
  glassStrength: "balanced",
  reducedMotion: false,
  compactTelemetry: false,
  robotName: "WL1 · Aurora",
  ledColor: "#6d7cff",
  bootPose: "balanced",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneOf = <Value extends string>(value: unknown, choices: readonly Value[]): value is Value =>
  typeof value === "string" && choices.includes(value as Value);

export function sanitizeProfiles(value: unknown): ParameterProfile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ParameterProfile[] => {
    if (!isRecord(candidate)) return [];
    if (typeof candidate.id !== "string" || !candidate.id || candidate.id.length > 80) return [];
    if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 64) return [];
    if (typeof candidate.description !== "string" || candidate.description.length > 240) return [];
    if (typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt) || candidate.updatedAt < 0) return [];
    if (!isRecord(candidate.values)) return [];

    const values: ParameterValues = {};
    for (const definition of parameterDefinitions) {
      const parameter = candidate.values[definition.id];
      if (typeof parameter === "number" && Number.isFinite(parameter) && parameter >= definition.min && parameter <= definition.max) {
        values[definition.id] = parameter;
      }
    }
    return [{
      id: candidate.id,
      name: candidate.name.trim(),
      description: candidate.description,
      updatedAt: candidate.updatedAt,
      values,
    }];
  });
}

export function sanitizePersonalization(value: unknown): PersonalizationSettings {
  if (!isRecord(value)) return { ...defaultPersonalization };
  return {
    accent: oneOf(value.accent, ["azure", "violet", "coral", "mint"] as const)
      ? value.accent
      : defaultPersonalization.accent,
    glassStrength: oneOf(value.glassStrength, ["soft", "balanced", "clear"] as const)
      ? value.glassStrength
      : defaultPersonalization.glassStrength,
    reducedMotion: typeof value.reducedMotion === "boolean"
      ? value.reducedMotion
      : defaultPersonalization.reducedMotion,
    compactTelemetry: typeof value.compactTelemetry === "boolean"
      ? value.compactTelemetry
      : defaultPersonalization.compactTelemetry,
    robotName: typeof value.robotName === "string"
      ? value.robotName.slice(0, 28)
      : defaultPersonalization.robotName,
    ledColor: typeof value.ledColor === "string" && /^#[0-9a-f]{6}$/i.test(value.ledColor)
      ? value.ledColor
      : defaultPersonalization.ledColor,
    bootPose: oneOf(value.bootPose, ["balanced", "low", "last"] as const)
      ? value.bootPose
      : defaultPersonalization.bootPose,
  };
}

export function loadProfiles(): ParameterProfile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "[]");
    return sanitizeProfiles(parsed);
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: ParameterProfile[]): boolean {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles));
    return true;
  } catch {
    // Settings remain usable in memory when storage is unavailable or full.
    return false;
  }
}

export function loadPersonalization(): PersonalizationSettings {
  try {
    return sanitizePersonalization(JSON.parse(localStorage.getItem(PERSONALIZATION_KEY) ?? "{}"));
  } catch {
    return defaultPersonalization;
  }
}

export function savePersonalization(settings: PersonalizationSettings): boolean {
  try {
    localStorage.setItem(PERSONALIZATION_KEY, JSON.stringify(settings));
    return true;
  } catch {
    // Keep the live UI state even if persistence is unavailable.
    return false;
  }
}
