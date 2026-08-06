/**
 * State and upload queue for the statement pages a treasurer is adding.
 *
 * Pages live here in the browser as thumbnails plus a small status record. The
 * image bytes are handed to the upload and then dropped; only the object URL for
 * the thumbnail is kept, and that is revoked as soon as the page is removed.
 *
 * Uploads run a few at a time rather than all at once, so a ten-page statement
 * on a phone connection does not open ten simultaneous requests, and so one slow
 * page does not stall the rest.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_PAGES_PER_SESSION, PAGE_UPLOAD_CONCURRENCY } from "../config";
import {
  isPdf,
  preparePage,
  splitPdfPages,
  type PagePreparationWarning,
} from "./image-prep";
import { ReconciliationApiError, clearAllPages, deletePage, uploadPage } from "./api-client";

export type PageStage =
  | "preparing"
  | "waiting"
  | "uploading"
  | "reading"
  | "complete"
  | "unreadable"
  | "failed";

export type WizardPage = {
  /** Stable browser-generated id. Doubles as the server's idempotency key. */
  id: string;
  label: string;
  previewUrl: string;
  isPdf: boolean;
  stage: PageStage;
  /** What went wrong, in words the treasurer can act on. */
  message: string | null;
  prepWarning: PagePreparationWarning | null;
  lineCount: number;
  printedPageNumber: number | null;
  printedPageCount: number | null;
  warnings: string[];
};

type PendingUpload = { blob: Blob; fileName: string };

export type UseStatementPagesOptions = {
  sessionId: string | null;
  departmentId: string;
  token: string;
  onPagesSettled?: () => void;
};

const STAGE_LABELS: Record<PageStage, string> = {
  preparing: "Getting ready",
  waiting: "Waiting",
  uploading: "Uploading",
  reading: "Reading",
  complete: "Complete",
  unreadable: "Needs a clearer photo",
  failed: "Failed — retry",
};

export function stageLabel(stage: PageStage): string {
  return STAGE_LABELS[stage];
}

export function useStatementPages(options: UseStatementPagesOptions) {
  const { sessionId, departmentId, token } = options;

  const [pages, setPages] = useState<WizardPage[]>([]);
  const [addError, setAddError] = useState<string | null>(null);

  // Blobs are held outside React state: they are large, they are not rendered,
  // and a retry needs the exact bytes that were prepared.
  const blobs = useRef(new Map<string, PendingUpload>());
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const settledCallback = useRef(options.onPagesSettled);
  settledCallback.current = options.onPagesSettled;

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(() => {
    const urls = blobs.current;
    return () => {
      // Unmount: release every thumbnail so the images are not left in memory.
      for (const page of pagesRef.current) {
        if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
      }
      urls.clear();
    };
  }, []);

  const patchPage = useCallback((id: string, patch: Partial<WizardPage>) => {
    setPages((current) =>
      current.map((page) => (page.id === id ? { ...page, ...patch } : page)),
    );
  }, []);

  const pump = useCallback(() => {
    if (!sessionId) return;

    while (active.current < PAGE_UPLOAD_CONCURRENCY && queue.current.length) {
      const id = queue.current.shift();
      if (!id) break;

      const upload = blobs.current.get(id);
      if (!upload) continue;

      active.current += 1;
      patchPage(id, { stage: "uploading", message: null });

      // Page order is read at send time so a reorder made while the queue is
      // draining is what the server records.
      const order = Math.max(1, pagesRef.current.findIndex((page) => page.id === id) + 1);

      void uploadPage({
        token,
        sessionId,
        departmentId,
        clientPageId: id,
        pageOrder: order,
        totalPages: pagesRef.current.length,
        blob: upload.blob,
        fileName: upload.fileName,
      })
        .then((result) => {
          patchPage(id, {
            stage: result.page.status,
            message: result.page.statusDetail,
            lineCount: result.page.lineCount,
            printedPageNumber: result.page.printedPageNumber,
            printedPageCount: result.page.printedPageCount,
            warnings: result.page.warnings,
          });
        })
        .catch((error: unknown) => {
          patchPage(id, {
            stage: "failed",
            message:
              error instanceof ReconciliationApiError
                ? error.message
                : "This page could not be read. Tap retry to try again.",
          });
        })
        .finally(() => {
          active.current -= 1;
          if (queue.current.length) {
            pump();
          } else if (active.current === 0) {
            settledCallback.current?.();
          }
        });
    }
  }, [departmentId, patchPage, sessionId, token]);

  // A session created after pages were picked still needs those pages sent.
  useEffect(() => {
    if (sessionId && queue.current.length) pump();
  }, [pump, sessionId]);

  const enqueue = useCallback(
    (id: string) => {
      queue.current.push(id);
      patchPage(id, { stage: "waiting", message: null });
      pump();
    },
    [patchPage, pump],
  );

  /** Prepare and queue a set of chosen files. PDFs are split page by page. */
  const addFiles = useCallback(
    async (files: File[]) => {
      setAddError(null);
      if (!files.length) return;

      // A resumed draft can still hold page rows from earlier failed visits even
      // when this browser tab shows none (images are never stored). Clear those
      // before adding a fresh set so a 4-page PDF cannot trip the 20-page cap.
      if (sessionId && pagesRef.current.length === 0) {
        try {
          await clearAllPages({ token, sessionId, departmentId });
        } catch {
          // Best effort — the upload route also purges failed/empty pages.
        }
      }

      const expanded: File[] = [];
      for (const file of files) {
        if (isPdf(file)) {
          try {
            expanded.push(...(await splitPdfPages(file)));
          } catch {
            setAddError(
              "That PDF could not be opened in this browser. Try exporting it again from your bank, or take photos of each page instead.",
            );
            return;
          }
        } else {
          expanded.push(file);
        }
      }

      const room = MAX_PAGES_PER_SESSION - pagesRef.current.length;
      if (room <= 0) {
        setAddError(`A statement can have at most ${MAX_PAGES_PER_SESSION} pages.`);
        return;
      }
      if (expanded.length > room) {
        setAddError(
          `Only the first ${room} of those pages were added. A statement can have at most ${MAX_PAGES_PER_SESSION} pages.`,
        );
      }

      for (const file of expanded.slice(0, room)) {
        const id = newPageId();

        setPages((current) => [
          ...current,
          {
            id,
            label: file.name || `Page ${current.length + 1}`,
            previewUrl: "",
            isPdf: isPdf(file),
            stage: "preparing",
            message: null,
            prepWarning: null,
            lineCount: 0,
            printedPageNumber: null,
            printedPageCount: null,
            warnings: [],
          },
        ]);

        const prepared = await preparePage(file);

        if (prepared.blocked) {
          patchPage(id, {
            stage: "unreadable",
            message: prepared.warningMessage,
            prepWarning: prepared.warning,
            previewUrl: prepared.previewUrl,
          });
          continue;
        }

        blobs.current.set(id, { blob: prepared.blob, fileName: prepared.fileName });
        patchPage(id, {
          previewUrl: prepared.previewUrl,
          prepWarning: prepared.warning,
          message: prepared.warningMessage,
        });
        enqueue(id);
      }
    },
    [departmentId, enqueue, patchPage, sessionId, token],
  );

  const retryPage = useCallback(
    (id: string) => {
      if (!blobs.current.has(id)) return;
      enqueue(id);
    },
    [enqueue],
  );

  const removePage = useCallback(
    (id: string) => {
      queue.current = queue.current.filter((queued) => queued !== id);
      blobs.current.delete(id);
      setPages((current) => {
        const page = current.find((candidate) => candidate.id === id);
        if (page?.previewUrl) URL.revokeObjectURL(page.previewUrl);
        return current.filter((candidate) => candidate.id !== id);
      });

      if (sessionId) {
        void deletePage({ token, sessionId, departmentId, clientPageId: id }).catch(() => {
          // Local removal already happened; a failed server delete is cleaned up
          // the next time this draft is resumed or a fresh upload starts.
        });
      }
    },
    [departmentId, sessionId, token],
  );

  const movePage = useCallback((id: string, direction: -1 | 1) => {
    setPages((current) => {
      const index = current.findIndex((page) => page.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    for (const page of pagesRef.current) {
      if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
    }
    blobs.current.clear();
    queue.current = [];
    setPages([]);
    setAddError(null);
  }, []);

  const busy = pages.some(
    (page) => page.stage === "preparing" || page.stage === "waiting" || page.stage === "uploading",
  );
  const readableCount = pages.filter((page) => page.stage === "complete").length;
  const transactionLineCount = pages.reduce(
    (total, page) => total + (page.stage === "complete" ? page.lineCount : 0),
    0,
  );
  const problemCount = pages.filter(
    (page) => page.stage === "unreadable" || page.stage === "failed",
  ).length;

  return {
    pages,
    addFiles,
    addError,
    retryPage,
    removePage,
    movePage,
    reset,
    busy,
    readableCount,
    transactionLineCount,
    problemCount,
  };
}

function newPageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `page-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
