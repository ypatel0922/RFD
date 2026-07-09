"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { BrandLogo } from "../../components/brand-logo";
import { supabase } from "../../lib/supabase";

type PageState = "loading" | "ready" | "success" | "invalid";

function getAuthParamsFromUrl() {
  if (typeof window === "undefined") {
    return {
      error: null,
      errorDescription: null,
      code: null,
      tokenHash: null,
      accessToken: null,
      refreshToken: null,
      type: null,
      hasAuthParams: false,
    };
  }

  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));

  const error = search.get("error") || hash.get("error");
  const errorDescription = search.get("error_description") || hash.get("error_description");
  const code = search.get("code");
  const tokenHash = search.get("token_hash");
  const accessToken = hash.get("access_token") || search.get("access_token");
  const refreshToken = hash.get("refresh_token") || search.get("refresh_token");
  const type = hash.get("type") || search.get("type");

  return {
    error,
    errorDescription,
    code,
    tokenHash,
    accessToken,
    refreshToken,
    type,
    hasAuthParams: Boolean(
      error ||
        errorDescription ||
        code ||
        tokenHash ||
        accessToken ||
        refreshToken ||
        type === "recovery",
    ),
  };
}

function clearSensitiveAuthParamsFromUrl() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.delete("token_hash");
  url.searchParams.delete("type");
  url.searchParams.delete("code");
  url.searchParams.delete("access_token");
  url.searchParams.delete("refresh_token");
  window.history.replaceState(window.history.state, "", url.toString());
}

export default function ResetPasswordPage() {
  const [pageState, setPageState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const resolvedRef = useRef(false);

  useEffect(() => {
    let mounted = true;

    function markReady() {
      if (!mounted || resolvedRef.current) return;
      resolvedRef.current = true;
      setPageState("ready");
      setError(null);
    }

    function markInvalid(message: string) {
      if (!mounted || resolvedRef.current) return;
      resolvedRef.current = true;
      setPageState("invalid");
      setError(message);
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === "PASSWORD_RECOVERY" || (session && event === "SIGNED_IN")) {
        markReady();
      }
    });

    async function establishRecoverySession() {
      const authParams = getAuthParamsFromUrl();

      if (authParams.error || authParams.errorDescription) {
        markInvalid(authParams.errorDescription || authParams.error || "This reset link is invalid or has expired.");
        return;
      }

      if (authParams.tokenHash && authParams.type === "recovery") {
        const { data, error: verifyError } = await supabase.auth.verifyOtp({
          token_hash: authParams.tokenHash,
          type: "recovery",
        });
        if (!mounted || resolvedRef.current) return;
        if (verifyError) {
          markInvalid(verifyError.message);
          return;
        }
        if (data.session) {
          clearSensitiveAuthParamsFromUrl();
          markReady();
          return;
        }
      }

      if (authParams.code) {
        const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(authParams.code);
        if (!mounted || resolvedRef.current) return;
        if (exchangeError) {
          markInvalid(
            exchangeError.message.includes("code verifier")
              ? "Open this reset link in the same browser where you requested it, or request a new reset email from the login page."
              : exchangeError.message,
          );
          return;
        }
        if (data.session) {
          clearSensitiveAuthParamsFromUrl();
          markReady();
          return;
        }
      }

      if (authParams.accessToken && authParams.refreshToken) {
        const { data, error: sessionError } = await supabase.auth.setSession({
          access_token: authParams.accessToken,
          refresh_token: authParams.refreshToken,
        });
        if (!mounted || resolvedRef.current) return;
        if (sessionError) {
          markInvalid(sessionError.message);
          return;
        }
        if (data.session) {
          clearSensitiveAuthParamsFromUrl();
          markReady();
          return;
        }
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted || resolvedRef.current) return;
      if (session) {
        markReady();
        return;
      }

      if (!authParams.hasAuthParams) {
        markInvalid(
          "No reset token was found in this link. Request a new password reset email from the login page. If the problem continues, the Supabase reset-password email template may need to be updated (see project docs).",
        );
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const {
        data: { session: retrySession },
      } = await supabase.auth.getSession();
      if (!mounted || resolvedRef.current) return;
      if (retrySession) {
        markReady();
        return;
      }

      markInvalid("This reset link is invalid or has expired. Request a new one from the login page.");
    }

    void establishRecoverySession();

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("new_password") || "");
    const confirmPassword = String(form.get("confirm_password") || "");

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      await supabase.auth.signOut();
      setPageState("success");
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Could not update your password.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-layout">
        <section className="card auth-card">
          <div className="firebook-brand" aria-label="Hallix">
            <BrandLogo className="firebook-brand__logo" tone="dark" priority />
            <span className="firebook-brand__tagline">AI bookkeeping for fire departments</span>
          </div>
          <h1 className="auth-title">Reset your password</h1>
          <p className="auth-lede">Choose a new password for your Hallix account.</p>

          {pageState === "loading" ? (
            <p className="auth-loading" style={{ color: "var(--muted)" }}>
              Verifying reset link…
            </p>
          ) : null}

          {pageState === "invalid" ? (
            <>
              {error ? (
                <div className="notice notice-error" role="alert">
                  {error}
                </div>
              ) : null}
              <p className="auth-switch">
                <Link href="/login">Back to log in</Link>
              </p>
            </>
          ) : null}

          {pageState === "success" ? (
            <>
              <div className="notice" role="status">
                Your password has been updated. You can now log in with your new password.
              </div>
              <p className="auth-switch">
                <Link href="/login">Back to log in</Link>
              </p>
            </>
          ) : null}

          {pageState === "ready" ? (
            <form onSubmit={handleSubmit} className="upload-form">
              {error ? (
                <div className="notice notice-error" role="alert">
                  {error}
                </div>
              ) : null}
              <label>
                New password
                <input
                  type="password"
                  name="new_password"
                  autoComplete="new-password"
                  required
                  disabled={submitting}
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  name="confirm_password"
                  autoComplete="new-password"
                  required
                  disabled={submitting}
                />
              </label>
              <button type="submit" disabled={submitting}>
                {submitting ? "Updating…" : "Update password"}
              </button>
              <p className="auth-switch">
                <Link href="/login">Back to log in</Link>
              </p>
            </form>
          ) : null}
        </section>
      </main>
    </div>
  );
}
