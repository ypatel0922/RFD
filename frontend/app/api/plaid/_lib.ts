import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { createClient } from "@supabase/supabase-js";

export function plaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || "sandbox";
  if (!clientId || !secret) {
    throw new Error("Set PLAID_CLIENT_ID and PLAID_SECRET.");
  }
  const environment = PlaidEnvironments[env as keyof typeof PlaidEnvironments] || PlaidEnvironments.sandbox;
  return new PlaidApi(
    new Configuration({
      basePath: environment,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
      },
    }),
  );
}

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for server APIs.");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
