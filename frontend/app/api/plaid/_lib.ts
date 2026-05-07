import { createClient } from "@supabase/supabase-js";

export function plaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || "sandbox";
  if (!clientId || !secret) {
    throw new Error("Set PLAID_CLIENT_ID and PLAID_SECRET.");
  }
  const baseUrlByEnv: Record<string, string> = {
    sandbox: "https://sandbox.plaid.com",
    development: "https://development.plaid.com",
    production: "https://production.plaid.com",
  };
  return {
    clientId,
    secret,
    baseUrl: baseUrlByEnv[env] || baseUrlByEnv.sandbox,
  };
}

export async function plaidRequest<T>(
  path: string,
  body: Record<string, unknown>,
) {
  const { clientId, secret, baseUrl } = plaidConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      secret,
      ...body,
    }),
  });
  const payload = (await response.json()) as T & { error_message?: string };
  if (!response.ok) {
    throw new Error(payload.error_message || `Plaid request failed for ${path}`);
  }
  return payload;
}

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for server APIs.");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
