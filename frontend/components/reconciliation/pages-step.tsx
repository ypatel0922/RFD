/**
 * Step 2 — capture the statement pages.
 *
 * Two separate inputs on purpose. Mobile browsers will not reliably return more
 * than one photo from a single `capture` session, so "Take a Photo" opens the
 * camera for exactly one page and the treasurer taps it again for the next page.
 * "Choose Photos or Files" is the multi-select path for pages already in the
 * camera roll or a PDF from online banking.
 */

"use client";

import { useRef } from "react";

import { ACCEPTED_PAGE_MIME_TYPES, MAX_PAGES_PER_SESSION } from "../../lib/reconciliation/config";
import {
  stageLabel,
  type PageStage,
  type WizardPage,
} from "../../lib/reconciliation/client/use-statement-pages";

const FILE_ACCEPT = [...ACCEPTED_PAGE_MIME_TYPES, ".heic", ".heif"].join(",");

const STAGE_TONE: Record<PageStage, string> = {
  preparing: "busy",
  waiting: "idle",
  uploading: "busy",
  reading: "busy",
  complete: "good",
  unreadable: "warn",
  failed: "bad",
};

export function PagesStep({
  pages,
  addError,
  busy,
  readableCount,
  transactionLineCount,
  problemCount,
  onAddFiles,
  onRetry,
  onRemove,
  onMove,
  onBack,
  onReview,
  reviewing,
}: {
  pages: WizardPage[];
  addError: string | null;
  busy: boolean;
  readableCount: number;
  transactionLineCount: number;
  problemCount: number;
  onAddFiles: (files: File[]) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onBack: () => void;
  onReview: () => void;
  reviewing: boolean;
}) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  function handleChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    // Reset first: picking the same file twice in a row otherwise fires no
    // change event, which makes retaking a page appear to do nothing.
    event.target.value = "";
    if (files.length) onAddFiles(files);
  }

  const atLimit = pages.length >= MAX_PAGES_PER_SESSION;

  return (
    <div className="fb-stmt-step-body">
      <div className="fb-stmt-intro">
        <h2>Add every page of the statement</h2>
        <p className="fb-stmt-instructions">
          Include every page of the statement, especially the first and last pages showing the
          statement dates and balances. Keep the page flat, well lit, and fully inside the photo.
          PDFs from your bank app are converted to page images automatically before reading — you
          should see a thumbnail of each page after upload.
        </p>
      </div>

      <div className="fb-stmt-capture">
        <button
          type="button"
          className="fb-stmt-capture-btn fb-stmt-capture-btn--primary"
          onClick={() => cameraInput.current?.click()}
          disabled={atLimit}
        >
          <CameraIcon />
          <span>{pages.length ? "Add another page" : "Take a Photo"}</span>
        </button>
        <button
          type="button"
          className="fb-stmt-capture-btn"
          onClick={() => libraryInput.current?.click()}
          disabled={atLimit}
        >
          <LibraryIcon />
          <span>Choose Photos or Files</span>
        </button>
      </div>

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="fb-visually-hidden"
        onChange={handleChosen}
      />
      <input
        ref={libraryInput}
        type="file"
        accept={FILE_ACCEPT}
        multiple
        className="fb-visually-hidden"
        onChange={handleChosen}
      />

      {addError ? <p className="fb-stmt-inline-error">{addError}</p> : null}

      <div className="fb-stmt-page-count">
        <strong>
          {pages.length} {pages.length === 1 ? "page" : "pages"} added
        </strong>
        {readableCount ? <span> · {readableCount} read successfully</span> : null}
        {transactionLineCount ? (
          <span>
            {" "}
            · {transactionLineCount} {transactionLineCount === 1 ? "transaction" : "transactions"}{" "}
            found
          </span>
        ) : null}
        {problemCount ? (
          <span className="fb-stmt-page-count-warn"> · {problemCount} need attention</span>
        ) : null}
      </div>

      {readableCount > 0 && transactionLineCount === 0 ? (
        <p className="fb-stmt-inline-error" role="status">
          Hallix read the page header but found no transactions yet. Add the activity pages that
          list deposits and withdrawals, or retake any page that shows 0 transactions.
        </p>
      ) : null}

      {pages.length ? (
        <ul className="fb-stmt-page-grid">
          {pages.map((page, index) => (
            <PageCard
              key={page.id}
              page={page}
              index={index}
              total={pages.length}
              onRetry={() => onRetry(page.id)}
              onRemove={() => onRemove(page.id)}
              onMove={(direction) => onMove(page.id, direction)}
            />
          ))}
        </ul>
      ) : (
        <div className="fb-stmt-empty">
          <h3>No pages yet</h3>
          <p>Take a photo of the first page to get started. You can add the rest one at a time.</p>
        </div>
      )}

      <div className="fb-stmt-actions">
        <button type="button" className="fb-secondary-btn" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="fb-primary-btn"
          disabled={busy || reviewing || transactionLineCount === 0}
          onClick={onReview}
        >
          {reviewing
            ? "Reading statement…"
            : busy
              ? "Still reading pages…"
              : transactionLineCount === 0
                ? "Add pages with transactions"
                : "Review statement"}
        </button>
      </div>
    </div>
  );
}

function PageCard({
  page,
  index,
  total,
  onRetry,
  onRemove,
  onMove,
}: {
  page: WizardPage;
  index: number;
  total: number;
  onRetry: () => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const tone = STAGE_TONE[page.stage];
  const printed =
    page.printedPageNumber != null
      ? `Statement page ${page.printedPageNumber}${
          page.printedPageCount ? ` of ${page.printedPageCount}` : ""
        }`
      : null;

  return (
    <li className={`fb-stmt-page-card fb-stmt-page-card--${tone}`}>
      <div className="fb-stmt-page-thumb">
        {page.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from the
          // treasurer's own photo; next/image cannot optimize it and must not try.
          <img src={page.previewUrl} alt={`Statement page ${index + 1}`} />
        ) : (
          <span className="fb-stmt-page-thumb-fallback">{page.isPdf ? "PDF" : index + 1}</span>
        )}
        <span className="fb-stmt-page-index">{index + 1}</span>
      </div>

      <div className="fb-stmt-page-info">
        <span className={`fb-stmt-page-status fb-stmt-page-status--${tone}`}>
          {stageLabel(page.stage)}
        </span>
        {page.stage === "complete" ? (
          <span className="fb-stmt-page-detail">
            {page.lineCount} {page.lineCount === 1 ? "transaction" : "transactions"}
            {printed ? ` · ${printed}` : ""}
          </span>
        ) : null}
        {page.message ? <span className="fb-stmt-page-detail">{page.message}</span> : null}
      </div>

      <div className="fb-stmt-page-actions">
        <button
          type="button"
          className="fb-icon-button"
          aria-label="Move page earlier"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="fb-icon-button"
          aria-label="Move page later"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        {page.stage === "failed" || page.stage === "unreadable" ? (
          <button type="button" className="fb-stmt-page-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        <button
          type="button"
          className="fb-stmt-page-remove"
          onClick={onRemove}
          aria-label={`Remove page ${index + 1}`}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function LibraryIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}
