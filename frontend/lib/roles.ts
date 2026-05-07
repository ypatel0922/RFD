export const ROLE_OPTIONS = [
  "Chief",
  "Captain",
  "Lieutenant",
  "Secretary",
  "Treasurer",
  "Other",
  "Member"
] as const;

export type RoleOption = (typeof ROLE_OPTIONS)[number];
