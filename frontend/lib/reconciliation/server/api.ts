/**
 * Shared response and request-validation helpers for reconciliation routes.
 *
 * Errors returned to the browser are always plain sentences a fire department
 * treasurer can act on. Stack traces, provider names, SQL messages and model
 * output never leave the server.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import type { AuthFailure } from "./auth";

export function ok<T extends Record<string, unknown>>(payload: T) {
  return NextResponse.json({ ok: true, ...payload });
}

export function fail(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}

export function failFromAuth(failure: AuthFailure) {
  return fail(failure.status, failure.message);
}

/** Generic message for anything unexpected. Details stay in the server log. */
export const UNEXPECTED_ERROR =
  "Something went wrong while reconciling. Nothing was changed. Please try again.";

/**
 * Log a server-side problem without ever including request bodies, image bytes,
 * account numbers, or extracted statement content.
 */
export function logReconciliationError(operation: string, error: unknown): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message.slice(0, 200)}`
      : "non-error thrown";
  console.error(`[reconciliation] ${operation} failed — ${detail}`);
}

export async function parseJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.infer<Schema> | AuthFailure> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, message: "That request could not be read. Please try again." };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { status: 400, message: firstIssueMessage(parsed.error) };
  }
  return parsed.data;
}

function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "That request was missing required information.";
  return issue.message || "That request was missing required information.";
}

const uuid = z.string().uuid("A valid identifier is required.");
const money = z
  .union([z.number(), z.string()])
  .nullable()
  .optional();

export const createSessionBodySchema = z.object({
  departmentId: uuid,
  bankAccountId: uuid,
  /** Reuse an existing draft for this account instead of starting over. */
  resumeExisting: z.boolean().optional().default(true),
});

export const consolidateBodySchema = z.object({
  departmentId: uuid,
  manualBeginningBalance: money,
  manualEndingBalance: money,
  manualStatementStartDate: z.string().nullable().optional(),
  manualStatementEndDate: z.string().nullable().optional(),
});

export const lineCorrectionSchema = z.object({
  postedDate: z.string().nullable().optional(),
  originalDescription: z.string().max(500).nullable().optional(),
  signedAmount: money,
  checkNumber: z.string().max(32).nullable().optional(),
  referenceNumber: z.string().max(64).nullable().optional(),
});

export type LineCorrectionInput = z.infer<typeof lineCorrectionSchema>;

export const patchLineBodySchema = z.object({
  departmentId: uuid,
  action: z.enum(["match", "unmatch", "not_applicable", "correct", "reset"]),
  expenseId: uuid.nullable().optional(),
  correction: lineCorrectionSchema.optional(),
});

export const confirmBodySchema = z.object({
  departmentId: uuid,
  /** Explicit list so the browser confirms exactly what it displayed. */
  lineIds: z.array(uuid).max(2000),
  overrideReason: z.string().trim().max(500).nullable().optional(),
});

export const deletePageQuerySchema = z
  .object({
    departmentId: uuid,
    clientPageId: z.string().min(1).max(128).optional(),
    clearAll: z
      .union([z.literal("1"), z.literal("true"), z.literal("false"), z.literal("")])
      .optional(),
  })
  .refine((value) => value.clearAll === "1" || value.clearAll === "true" || Boolean(value.clientPageId), {
    message: "A page to remove is required.",
  });
