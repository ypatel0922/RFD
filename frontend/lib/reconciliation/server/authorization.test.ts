/**
 * Scenario 21 — a user must never reach another department's reconciliation.
 *
 * The fake Supabase client below applies `.eq()` filters for real, which is what
 * row level security does in production for these same columns. Combined with
 * the explicit membership check, a request carrying a valid token but the wrong
 * department id has to be refused.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const HOME_DEPARTMENT = "11111111-1111-4111-8111-111111111111";
const OTHER_DEPARTMENT = "22222222-2222-4222-8222-222222222222";
const HOME_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOME_ACCOUNT = "33333333-3333-4333-8333-333333333333";
const OTHER_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;

/** Minimal stand-in for the Supabase query builder, with working filters. */
function table(rows: Row[]) {
  let working = [...rows];
  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq(column: string, value: unknown) {
      working = working.filter((row) => row[column] === value);
      return builder;
    },
    in(column: string, values: unknown[]) {
      working = working.filter((row) => values.includes(row[column]));
      return builder;
    },
    maybeSingle: async () => ({ data: working[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: working, error: null }),
  };
  return builder;
}

const DATABASE: Record<string, Row[]> = {
  department_members: [{ department_id: HOME_DEPARTMENT, user_id: HOME_USER, role: "treasurer" }],
  bank_accounts: [
    {
      id: HOME_ACCOUNT,
      department_id: HOME_DEPARTMENT,
      name: "Operating Checking",
      institution_name: "Cedar Hollow Community Bank",
      account_mask: "4417",
      account_type: "checking",
      last_reconciled_statement_end_date: null,
      last_reconciled_ending_balance: null,
    },
    { id: OTHER_ACCOUNT, department_id: OTHER_DEPARTMENT, name: "Someone Else's Checking" },
  ],
  reconciliation_sessions: [
    { id: OTHER_SESSION, department_id: OTHER_DEPARTMENT, status: "review" },
  ],
};

const createClient = vi.fn(() => ({
  auth: {
    getUser: async (token: string) =>
      token === "good-token"
        ? { data: { user: { id: HOME_USER, email: "treasurer@example.org" } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } },
  },
  from: (name: string) => table(DATABASE[name] ?? []),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

const { authorizeDepartmentRequest, isAuthFailure, requireDepartmentBankAccount } = await import(
  "./auth"
);
const { loadSession, ReconciliationDataError } = await import("./data-access");

function requestWith(token: string | null) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return { headers } as unknown as Parameters<typeof authorizeDepartmentRequest>[0];
}

async function homeContext() {
  const context = await authorizeDepartmentRequest(requestWith("good-token"), HOME_DEPARTMENT);
  if (isAuthFailure(context)) throw new Error("expected an authorized context");
  return context;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-for-tests";
});

describe("request authorization", () => {
  it("authorizes a member of the requested department", async () => {
    const context = await homeContext();
    expect(context.departmentId).toBe(HOME_DEPARTMENT);
    expect(context.role).toBe("treasurer");
  });

  it("refuses a request with no bearer token", async () => {
    const result = await authorizeDepartmentRequest(requestWith(null), HOME_DEPARTMENT);
    expect(isAuthFailure(result) && result.status).toBe(401);
  });

  it("refuses an expired or forged token", async () => {
    const result = await authorizeDepartmentRequest(requestWith("stale-token"), HOME_DEPARTMENT);
    expect(isAuthFailure(result) && result.status).toBe(401);
  });

  it("refuses a department the caller is not a member of", async () => {
    const result = await authorizeDepartmentRequest(requestWith("good-token"), OTHER_DEPARTMENT);
    expect(isAuthFailure(result) && result.status).toBe(403);
    expect(isAuthFailure(result) && result.message).toBe(
      "You do not have access to this department.",
    );
  });

  it("refuses a malformed department id before touching the database", async () => {
    const result = await authorizeDepartmentRequest(requestWith("good-token"), "not-a-uuid");
    expect(isAuthFailure(result) && result.status).toBe(400);
  });

  it("never uses the service role key", () => {
    for (const call of createClient.mock.calls as unknown as unknown[][]) {
      expect(String(call[1])).toBe("anon-key-for-tests");
    }
  });
});

describe("account ownership", () => {
  it("accepts an account belonging to the caller's department", async () => {
    const account = await requireDepartmentBankAccount(await homeContext(), HOME_ACCOUNT);
    expect(isAuthFailure(account)).toBe(false);
  });

  it("refuses an account that belongs to another department", async () => {
    const account = await requireDepartmentBankAccount(await homeContext(), OTHER_ACCOUNT);
    expect(isAuthFailure(account) && account.status).toBe(404);
  });
});

describe("session isolation", () => {
  it("cannot load another department's reconciliation even with a real session id", async () => {
    const context = await homeContext();
    await expect(loadSession(context.supabase, OTHER_SESSION, HOME_DEPARTMENT)).rejects.toThrow(
      ReconciliationDataError,
    );
  });

  it("reports the cross-department attempt as not found rather than forbidden", async () => {
    const context = await homeContext();
    // A 404 avoids confirming that the session id exists at all.
    await expect(
      loadSession(context.supabase, OTHER_SESSION, HOME_DEPARTMENT),
    ).rejects.toMatchObject({ status: 404 });
  });
});
