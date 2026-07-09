"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { BrandLogo } from "../../../components/brand-logo";

type RequestInfo = {
  found: boolean;
  status?: string;
  vendor?: string;
  amount?: number | string | null;
  date?: string | null;
  requestCode?: string;
};

export default function ReceiptRequestPage() {
  const params = useParams();
  const code = typeof params.code === "string" ? params.code.toUpperCase() : "";
  const fileRef = useRef<HTMLInputElement>(null);

  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    fetch(`/api/receipt-requests/info?code=${encodeURIComponent(code)}`)
      .then((r) => r.json())
      .then((data: RequestInfo) => {
        setInfo(data);
        setLoading(false);
      })
      .catch(() => {
        setInfo({ found: false });
        setLoading(false);
      });
  }, [code]);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Please select a receipt photo.");
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("receipt", file);
      formData.append("code", code);

      const response = await fetch("/api/receipt-requests/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Upload failed.");
      }

      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  if (loading) {
    return (
      <div className="receipt-request-page">
        <div className="receipt-request-card">
          <p className="receipt-request-loading">Looking up receipt request…</p>
        </div>
      </div>
    );
  }

  if (!info?.found || info.status === "completed") {
    return (
      <div className="receipt-request-page">
        <div className="receipt-request-card">
          <div className="receipt-request-logo">
            <BrandLogo className="receipt-request-logo-image" tone="dark" priority />
          </div>
          {info?.status === "completed" ? (
            <>
              <h1 className="receipt-request-title">Receipt already received</h1>
              <p className="receipt-request-body">
                This receipt request ({code}) has already been fulfilled. No action needed.
              </p>
            </>
          ) : (
            <>
              <h1 className="receipt-request-title">Request not found</h1>
              <p className="receipt-request-body">
                The reference code <strong>{code}</strong> was not found or may have expired.
                Check the original text message for the correct code, or reply to the text with your receipt photo.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="receipt-request-page">
        <div className="receipt-request-card">
          <div className="receipt-request-logo">
            <BrandLogo className="receipt-request-logo-image" tone="dark" priority />
          </div>
          <div className="receipt-request-success-icon" aria-hidden>✓</div>
          <h1 className="receipt-request-title">Receipt submitted!</h1>
          <p className="receipt-request-body">
            Hallix received your receipt for{" "}
            {info.vendor ? <strong>{info.vendor}</strong> : "this transaction"}.
            You're all set — you can close this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="receipt-request-page">
      <div className="receipt-request-card">
        <div className="receipt-request-logo">
          <BrandLogo className="receipt-request-logo-image" tone="dark" priority />
        </div>
        <h1 className="receipt-request-title">Upload your receipt</h1>
        <p className="receipt-request-ref">Ref: {code}</p>

        {info.vendor || info.amount || info.date ? (
          <div className="receipt-request-meta">
            {info.vendor ? <span className="receipt-request-meta-vendor">{info.vendor}</span> : null}
            {info.amount != null ? (
              <span className="receipt-request-meta-amount">
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                  Math.abs(Number(info.amount)),
                )}
              </span>
            ) : null}
            {info.date ? <span className="receipt-request-meta-date">{info.date}</span> : null}
          </div>
        ) : null}

        <p className="receipt-request-body">
          Take a photo of the receipt and upload it below, or simply reply to the original text message with the photo.
        </p>

        <form className="receipt-request-form" onSubmit={(e) => void handleSubmit(e)}>
          <label className="receipt-request-file-label">
            {preview ? (
              <img src={preview} alt="Receipt preview" className="receipt-request-preview" />
            ) : (
              <div className="receipt-request-file-placeholder">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>Tap to select receipt photo</span>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="receipt-request-file-input"
              onChange={handleFileChange}
            />
          </label>

          {error ? <p className="receipt-request-error">{error}</p> : null}

          <button type="submit" className="receipt-request-submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Submit Receipt"}
          </button>
        </form>
      </div>

      <style>{`
        .receipt-request-page {
          min-height: 100svh;
          background: #f5f5f5;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }
        .receipt-request-card {
          background: #fff;
          border-radius: 12px;
          padding: 2rem 1.5rem;
          max-width: 420px;
          width: 100%;
          box-shadow: 0 2px 16px rgba(0,0,0,0.10);
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .receipt-request-logo { text-align: center; }
        .receipt-request-logo-image { display: inline-block; width: auto; height: 32px; max-width: 100%; }
        .receipt-request-logo-text { font-size: 1.25rem; font-weight: 700; color: #b91c1c; letter-spacing: -0.02em; }
        .receipt-request-title { font-size: 1.35rem; font-weight: 700; margin: 0; color: #111; }
        .receipt-request-ref { font-size: 0.8rem; color: #888; font-family: monospace; }
        .receipt-request-body { font-size: 0.95rem; color: #444; line-height: 1.5; margin: 0; }
        .receipt-request-meta { display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .receipt-request-meta span { background: #f1f5f9; border-radius: 4px; padding: 0.25rem 0.6rem; font-size: 0.9rem; }
        .receipt-request-meta-vendor { font-weight: 600; }
        .receipt-request-meta-amount { color: #b91c1c; font-weight: 600; }
        .receipt-request-meta-date { color: #555; }
        .receipt-request-form { display: flex; flex-direction: column; gap: 0.75rem; }
        .receipt-request-file-label { cursor: pointer; display: block; }
        .receipt-request-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; }
        .receipt-request-file-placeholder {
          border: 2px dashed #d1d5db;
          border-radius: 8px;
          padding: 2rem 1rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          color: #6b7280;
          font-size: 0.9rem;
          text-align: center;
        }
        .receipt-request-preview { width: 100%; border-radius: 8px; object-fit: contain; max-height: 240px; }
        .receipt-request-error { color: #b91c1c; font-size: 0.875rem; }
        .receipt-request-submit {
          background: #b91c1c;
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 0.85rem;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          width: 100%;
        }
        .receipt-request-submit:disabled { opacity: 0.6; cursor: not-allowed; }
        .receipt-request-success-icon { font-size: 2.5rem; color: #16a34a; text-align: center; }
        .receipt-request-loading { color: #888; text-align: center; padding: 2rem; }
      `}</style>
    </div>
  );
}
