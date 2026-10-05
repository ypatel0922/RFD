/**
 * Check images carry banking details, so the extraction route only serves a
 * signed-in member of the department the document belongs to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const DEPARTMENT = "11111111-1111-4111-8111-111111111111";

const authorize = vi.fn();
const extract = vi.fn();

vi.mock("../../../lib/reconciliation/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/reconciliation/server/auth")>();
  return { ...actual, authorizeDepartmentRequest: authorize };
});

vi.mock("../../../lib/extract-money-in-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/extract-money-in-server")>();
  return { ...actual, extractMoneyInFromBuffer: extract };
});

const { POST } = await import("./route");

function request(form: FormData, token = "token") {
  return new NextRequest("http://localhost/api/extract-money-in", {
    method: "POST",
    body: form,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function checkForm() {
  const form = new FormData();
  form.set("department_id", DEPARTMENT);
  form.set("document", new File([new Uint8Array([1, 2, 3])], "check.jpg", { type: "image/jpeg" }));
  form.set("categories", JSON.stringify(["Donations Received"]));
  return form;
}

beforeEach(() => {
  authorize.mockReset();
  extract.mockReset();
});

describe("POST /api/extract-money-in", () => {
  it("rejects a caller who is not signed in", async () => {
    authorize.mockResolvedValue({ status: 401, message: "Please sign in again." });
    const response = await POST(request(checkForm(), ""));
    expect(response.status).toBe(401);
    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects a member of another department", async () => {
    authorize.mockResolvedValue({ status: 403, message: "You do not have access to this department." });
    const response = await POST(request(checkForm()));
    expect(response.status).toBe(403);
    expect(extract).not.toHaveBeenCalled();
  });

  it("reads the document for an authorized member and never caches the result", async () => {
    authorize.mockResolvedValue({ supabase: {}, user: { id: "u" }, userEmail: null, departmentId: DEPARTMENT, role: "treasurer" });
    extract.mockResolvedValue({ payer: "Smith Family", amount: "250.00" });
    const response = await POST(request(checkForm()));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(authorize).toHaveBeenCalledWith(expect.anything(), DEPARTMENT);
    expect(extract).toHaveBeenCalledWith(expect.any(Buffer), "image/jpeg", { allowedCategories: ["Donations Received"] });
  });
});
