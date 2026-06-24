"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";

import { supabase } from "../../lib/supabase";

type PageState = "loading" | "ready" | "success" | "invalid";

export default function ResetPasswordPage() {
  const [pageState, setPageState] = useState<PageState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (session && (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        setPageState("ready");
        setError(null);
      }
    });

    async function checkSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!mounted) return;
      if (session) {
        setPageState("ready");
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 400));

      const {
        data: { session: retrySession },
      } = await supabase.auth.getSession();
      if (!mounted) return;
      if (retrySession) {
        setPageState("ready");
        return;
      }

      setPageState("invalid");
      setError("This reset link is invalid or has expired. Request a new one from the login page.");
    }

    void checkSession();

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
          <div className="firebook-brand" aria-label="Firebook">
            <span className="firebook-brand__wordmark">Firebook</span>
            <span className="firebook-brand__tagline">Fire department bookkeeping</span>
          </div>
          <h1 className="auth-title">Reset your password</h1>
          <p className="auth-lede">Choose a new password for your Firebook account.</p>

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
