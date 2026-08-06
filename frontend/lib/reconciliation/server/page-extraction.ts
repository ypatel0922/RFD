/**
 * Pass 1 -- read one statement page.
 *
 * The bytes for a page arrive, are inspected, sent to the vision provider,
 * validated against the strict schema, normalized deterministically, and then
 * dropped. Nothing here writes the image to disk, to storage, or to a log.
 */

import { MAX_PAGE_BYTES } from "../config";
import { ExtractionValidationError, normalizePageExtraction, parseRawPage } from "../extraction-schema";
import type { PageExtractionResult } from "../types";
import { inspectPageBytes } from "./image-inspect";
import { VisionProviderError, type VisionProvider } from "./vision-provider";

export type PageExtractionOutcome =
  | { status: "complete"; result: PageExtractionResult; imageDigest: string }
  | { status: "unreadable"; reason: string; imageDigest: string | null }
  | { status: "failed"; reason: string; retryable: boolean; imageDigest: string | null };

export type ExtractPageInput = {
  bytes: Buffer;
  mimeType: string;
  pageNumber: number;
  totalPages: number;
  provider: VisionProvider;
};

/**
 * A one-way digest of the preprocessed bytes. Used only to notice that the same
 * photo was added twice; it cannot be turned back into an image.
 */
export async function digestPageBytes(bytes: Buffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(hash).toString("hex");
}

export async function extractStatementPage(input: ExtractPageInput): Promise<PageExtractionOutcome> {
  if (input.bytes.length > MAX_PAGE_BYTES) {
    return {
      status: "unreadable",
      reason: "That page file is too large. Retake the photo and it will be resized automatically.",
      imageDigest: null,
    };
  }

  const inspection = inspectPageBytes(input.bytes, input.mimeType);
  if (inspection.kind === "unreadable") {
    return { status: "unreadable", reason: inspection.reason, imageDigest: null };
  }

  const imageDigest = await digestPageBytes(input.bytes);

  try {
    const raw = await input.provider.extractPage({
      bytes: input.bytes,
      mimeType: inspection.format === "pdf" ? "application/pdf" : input.mimeType,
      pageNumber: input.pageNumber,
      totalPages: input.totalPages,
    });

    const validated = parseRawPage(raw);
    const result = normalizePageExtraction({
      raw: validated,
      pageNumber: input.pageNumber,
      model: input.provider.model,
    });

    // A page the model could open but read no transactions from is not ready
    // for matching. Treat it as needing a clearer photo / different page so the
    // treasurer cannot reach review with only a header and an empty line list.
    if (!result.lines.length) {
      return {
        status: "unreadable",
        reason: hasAnyHeaderValue(result)
          ? "The statement header was read, but no transactions were found on this page. If this came from a PDF, remove it and upload again after refreshing the page. Otherwise include the activity pages, or retake this photo so the transaction list is clear."
          : "Nothing could be read from this page. Make sure the page is flat, well lit, and fully inside the photo.",
        imageDigest,
      };
    }

    return { status: "complete", result, imageDigest };
  } catch (error) {
    if (error instanceof ExtractionValidationError) {
      return {
        status: "failed",
        reason: "This page could not be read reliably. Try a clearer photo of the page.",
        retryable: true,
        imageDigest,
      };
    }
    if (error instanceof VisionProviderError) {
      return { status: "failed", reason: error.message, retryable: error.retryable, imageDigest };
    }
    return {
      status: "failed",
      reason: "This page could not be read. Try again in a moment.",
      retryable: true,
      imageDigest,
    };
  }
}

function hasAnyHeaderValue(result: PageExtractionResult): boolean {
  const header = result.header;
  return Boolean(
    header.beginningBalanceCents != null ||
      header.endingBalanceCents != null ||
      header.statementStartDate ||
      header.statementEndDate ||
      header.accountLastFour ||
      header.financialInstitution ||
      header.printedPageNumber,
  );
}
