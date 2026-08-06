/**
 * Scenario 23 — the final confirmation is all-or-nothing.
 *
 * The route delegates every write to `confirm_statement_reconciliation`, so the
 * property under test is that the route itself never performs partial writes: if
 * the function raises, the response is an explanation and no other table was
 * touched. Re-posting a confirmation must also not reconcile a second time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DEPARTMENT = "11111111-1111-4111-8111-111111111111";
const SESSION = "55555555-5555-4555-8555-555555555555";
const LINE_A = "66666666-6666-4666-8666-666666666666";
const LINE_B = "77777777-7777-4777-8777-777777777777";

const rpc = vi.fn();
const from = vi.fn();
const loadSession = vi.fn();
const loadSessionView = vi.fn();

vi.mock("../../../../../../lib/reconciliation/server/auth", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../../../lib/reconciliation/server/auth")
  >();
  return {
    ...actual,
    authorizeDepartmentRequest: vi.fn(async () => ({
      supabase: { rpc, from },
      user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      userEmail: "treasurer@example.org",
      departmentId: DEPARTMENT,
      role: "treasurer",
    })),
  };
});

vi.mock("../../../../../../lib/reconciliation/server/data-access", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../../../../lib/reconciliation/server/data-access")
  >();
  return { ...actual, loadSession };
});

vi.mock("../../../../../../lib/reconciliation/server/load-session-view", () => ({
  loadSessionView,
}));

const { POST } = await import("./route");

function confirmRequest(body: Record<string, unknown>) {
  return new Request("https://hallix.test/api/reconciliation/sessions/x/confirm", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const routeContext = { params: Promise.resolve({ sessionId: SESSION }) };

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    department_id: DEPARTMENT,
    status: "review",
    validation_status: "balanced",
    confirmed_transaction_count: 0,
    confirmed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSession.mockResolvedValue(sessionRow());
  loadSessionView.mockResolvedValue({ session: { id: SESSION } });
  from.mockImplementation(() => {
    throw new Error("the confirm route must not write outside the atomic function");
  });
});

describe("successful confirmation", () => {
  it("confirms through the single database function and reports the count", async () => {
    rpc.mockResolvedValue({
      data: { already_confirmed: false, confirmed_count: 2, confirmed_at: "2025-04-02T15:00:00Z" },
      error: null,
    });

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A, LINE_B] }),
      routeContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.confirmedCount).toBe(2);
    expect(rpc).toHaveBeenCalledWith("confirm_statement_reconciliation", {
      p_session_id: SESSION,
      p_line_ids: [LINE_A, LINE_B],
      p_override_reason: null,
    });
    expect(from).not.toHaveBeenCalled();
  });
});

describe("a failure inside the function leaves nothing half-done", () => {
  it("explains a transaction reconciled elsewhere and states that nothing changed", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'RECONCILIATION_EXPENSE_ALREADY_RECONCILED (id "…")' },
    });

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A, LINE_B] }),
      routeContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Nothing was changed");
    expect(from).not.toHaveBeenCalled();
  });

  it("refuses a line belonging to another department", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "RECONCILIATION_EXPENSE_NOT_IN_DEPARTMENT" },
    });

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A] }),
      routeContext,
    );

    expect(response.status).toBe(403);
  });

  it("hides raw database text behind a generic message for unrecognized errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'deadlock detected on relation "expenses" pid 4132' },
    });

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A] }),
      routeContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toContain("Nothing was changed");
    expect(payload.error).not.toContain("deadlock");
    expect(payload.error).not.toContain("expenses");
  });
});

describe("guards before the function is called", () => {
  it("will not confirm an unbalanced statement without an explanation", async () => {
    loadSession.mockResolvedValue(sessionRow({ validation_status: "off_by_amount" }));

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A] }),
      routeContext,
    );

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a one-word override as an explanation", async () => {
    loadSession.mockResolvedValue(sessionRow({ validation_status: "off_by_amount" }));

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A], overrideReason: "fine" }),
      routeContext,
    );

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows a recorded override with a real explanation", async () => {
    loadSession.mockResolvedValue(sessionRow({ validation_status: "off_by_amount" }));
    rpc.mockResolvedValue({
      data: { already_confirmed: false, confirmed_count: 1, confirmed_at: "2025-04-02T15:00:00Z" },
      error: null,
    });

    const reason = "Bank posted a correction after the statement printed; documented in minutes.";
    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A], overrideReason: reason }),
      routeContext,
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "confirm_statement_reconciliation",
      expect.objectContaining({ p_override_reason: reason }),
    );
  });

  it("rejects a reconciliation link that is not a real identifier", async () => {
    const response = await POST(confirmRequest({ departmentId: DEPARTMENT, lineIds: [] }), {
      params: Promise.resolve({ sessionId: "../../etc/passwd" }),
    });

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("re-posting a confirmation", () => {
  it("returns the original result instead of reconciling twice", async () => {
    loadSession.mockResolvedValue(
      sessionRow({
        status: "confirmed",
        confirmed_transaction_count: 2,
        confirmed_at: "2025-04-02T15:00:00Z",
      }),
    );

    const response = await POST(
      confirmRequest({ departmentId: DEPARTMENT, lineIds: [LINE_A, LINE_B] }),
      routeContext,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.alreadyConfirmed).toBe(true);
    expect(payload.confirmedCount).toBe(2);
    expect(rpc).not.toHaveBeenCalled();
  });
});
