export const ROLE_OPTIONS = [
  "Chief",
  "Captain",
  "Lieutenant",
  "Secretary",
  "Treasurer",
  "Other",
] as const;

export type RoleOption = (typeof ROLE_OPTIONS)[number];
