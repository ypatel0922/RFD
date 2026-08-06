/**
 * Browser-side preparation of a statement page before it is uploaded.
 *
 * Phone photos arrive rotated, 12 megapixels and several megabytes each. A
 * ten-page statement in that state is tens of megabytes of upload over cellular
 * and a serverless request that times out. So each page is decoded, rotated
 * upright, downscaled to a size that still resolves 8pt statement text, and
 * re-encoded as JPEG here — before it ever leaves the phone.
 *
 * Bank PDFs are rasterized to JPEG the same way. Sending a raw PDF to the vision
 * model often returns the statement header with an empty transaction list;
 * rendering each page to an image uses the same path that already works for
 * photos. The original PDF is not stored.
 *
 * Nothing written here is persisted. The object URLs produced for thumbnails
 * live only as long as the wizard tab is open and are revoked when a page is
 * removed.
 */

import {
  MIN_CONTENT_STDDEV,
  MIN_PAGE_EDGE_PIXELS,
  MIN_PAGE_PIXELS,
  MIN_SHARPNESS_VARIANCE,
  PAGE_JPEG_QUALITY,
  TARGET_MAX_EDGE_PIXELS,
} from "../config";

export type PagePreparationWarning =
  | "too_small"
  | "blank"
  | "blurry"
  | "unsupported_format"
  | "decode_failed";

export type PreparedPage = {
  /** What actually gets uploaded. JPEG for photos and rasterized PDF pages. */
  blob: Blob;
  fileName: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** Object URL for the thumbnail. The caller must revoke it. */
  previewUrl: string;
  /** Set when the page is readable but the photo could be better. */
  warning: PagePreparationWarning | null;
  warningMessage: string | null;
  /** True when the page cannot be sent at all and must be replaced. */
  blocked: boolean;
};

export const WARNING_MESSAGES: Record<PagePreparationWarning, string> = {
  too_small:
    "This image is too small to read the amounts. Take the photo closer to the page, or pick a larger file.",
  blank:
    "This page looks blank. Check that the statement page is inside the photo and try again.",
  blurry:
    "This photo looks blurry. Hold the phone steady and make sure the whole page is in focus.",
  unsupported_format:
    "This browser cannot open that file type. On an iPhone, open Settings, then Camera, then Formats, and choose Most Compatible — or use the Take a Photo button.",
  decode_failed:
    "This file could not be opened. It may be damaged. Try taking the photo again.",
};

/**
 * Prepare one file for upload.
 *
 * PDF pages should already have been turned into JPEG files by `splitPdfPages`.
 * A leftover PDF is passed through as a last resort for the server PDF path.
 */
export async function preparePage(file: File): Promise<PreparedPage> {
  if (isPdf(file)) {
    return {
      blob: file,
      fileName: file.name || "statement.pdf",
      mimeType: "application/pdf",
      width: null,
      height: null,
      previewUrl: "",
      warning: null,
      warningMessage: null,
      blocked: false,
    };
  }

  const bitmap = await decodeUpright(file);
  if (!bitmap) {
    const warning: PagePreparationWarning = looksLikeHeic(file)
      ? "unsupported_format"
      : "decode_failed";
    return {
      blob: file,
      fileName: file.name || "page.jpg",
      mimeType: file.type || "application/octet-stream",
      width: null,
      height: null,
      previewUrl: "",
      warning,
      warningMessage: WARNING_MESSAGES[warning],
      blocked: true,
    };
  }

  try {
    const { canvas, width, height } = drawScaled(bitmap);
    const quality = inspectCanvas(canvas);
    const blob = await canvasToJpeg(canvas);

    const warning = pickWarning(width, height, quality);
    // Only a page with nothing legible on it is worth refusing outright. A
    // merely soft photo still often reads correctly, so it goes through with a
    // warning and the treasurer decides whether to retake it.
    const blocked = warning === "too_small" || warning === "blank";

    return {
      blob,
      fileName: toJpegName(file.name),
      mimeType: "image/jpeg",
      width,
      height,
      previewUrl: URL.createObjectURL(blob),
      warning,
      warningMessage: warning ? WARNING_MESSAGES[warning] : null,
      blocked,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Split a multi-page PDF into one JPEG per page so each page is extracted on
 * its own request, exactly like a photo.
 *
 * Bank-app PDFs are rendered to images here because sending the raw PDF to the
 * vision model frequently returns only the header (institution, balances) with
 * an empty transaction list. A rendered page uses the image path that already
 * reads transaction tables reliably.
 *
 * Falls back to one raw PDF file if the browser cannot render it (rare), so the
 * server can still try the PDF file path.
 */
export async function splitPdfPages(file: File): Promise<File[]> {
  return rasterizePdfToJpegPages(file);
}

async function rasterizePdfToJpegPages(file: File): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const data = new Uint8Array(await file.arrayBuffer());
  const pdfDocument = await pdfjs.getDocument({ data }).promise;
  const baseName = file.name.replace(/\.pdf$/i, "") || "statement";
  const pages: File[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const longestEdge = Math.max(baseViewport.width, baseViewport.height);
      // Match the photo prep target so 8pt statement text stays readable without
      // uploading an enormous canvas.
      const scale = Math.min(TARGET_MAX_EDGE_PIXELS / Math.max(longestEdge, 1), 3.5);
      const viewport = page.getViewport({ scale: Math.max(scale, 1.5) });

      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("Could not open a drawing surface for this PDF page.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await canvasToJpeg(canvas);
      pages.push(
        new File([blob], `${baseName}-page-${pageNumber}.jpg`, {
          type: "image/jpeg",
        }),
      );
    }
  } finally {
    await pdfDocument.destroy();
  }

  if (!pages.length) throw new Error("PDF contained no pages.");
  return pages;
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function looksLikeHeic(file: File): boolean {
  return /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

/**
 * Decode to a bitmap with EXIF rotation already applied.
 *
 * `imageOrientation: "from-image"` is the only reliable way to get this right
 * without parsing EXIF by hand; every browser that supports `createImageBitmap`
 * with options honours it. The `<img>` path is the fallback for older Safari,
 * which auto-orients images anyway.
 */
async function decodeUpright(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    if (typeof createImageBitmap === "function") {
      return await createImageBitmap(image);
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawScaled(bitmap: ImageBitmap): {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
} {
  const longestEdge = Math.max(bitmap.width, bitmap.height);
  // Never upscale: enlarging a small photo adds no detail and only inflates the
  // upload, and the resolution check below still needs to see the true size.
  const scale = longestEdge > TARGET_MAX_EDGE_PIXELS ? TARGET_MAX_EDGE_PIXELS / longestEdge : 1;

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
  }

  return { canvas, width, height };
}

type CanvasQuality = { stdDev: number; sharpness: number };

/**
 * Measure how much detail the photo actually contains.
 *
 * Two cheap statistics over a small grayscale copy: the spread of pixel values,
 * which collapses toward zero on a blank frame, and the variance of a Laplacian,
 * which collapses when nothing in the frame has a hard edge — the signature of a
 * blurry photo.
 */
function inspectCanvas(canvas: HTMLCanvasElement): CanvasQuality {
  const sampleWidth = Math.min(canvas.width, 512);
  const sampleHeight = Math.max(1, Math.round((canvas.height / canvas.width) * sampleWidth));

  const sample = document.createElement("canvas");
  sample.width = sampleWidth;
  sample.height = sampleHeight;

  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context) return { stdDev: Number.POSITIVE_INFINITY, sharpness: Number.POSITIVE_INFINITY };

  context.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);

  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  } catch {
    // A tainted canvas cannot be inspected. Assume the page is fine rather than
    // blocking a photo we simply could not measure.
    return { stdDev: Number.POSITIVE_INFINITY, sharpness: Number.POSITIVE_INFINITY };
  }

  const gray = new Float32Array(sampleWidth * sampleHeight);
  let total = 0;
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    const value = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
    gray[i] = value;
    total += value;
  }

  const mean = total / gray.length;
  let variance = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const delta = gray[i] - mean;
    variance += delta * delta;
  }
  const stdDev = Math.sqrt(variance / gray.length);

  return { stdDev, sharpness: laplacianVariance(gray, sampleWidth, sampleHeight) };
}

/** Variance of the 4-neighbour Laplacian: the standard cheap focus measure. */
function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return Number.POSITIVE_INFINITY;

  let total = 0;
  let totalSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const value =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      total += value;
      totalSquares += value * value;
      count += 1;
    }
  }

  if (!count) return Number.POSITIVE_INFINITY;
  const mean = total / count;
  return totalSquares / count - mean * mean;
}

function pickWarning(
  width: number,
  height: number,
  quality: CanvasQuality,
): PagePreparationWarning | null {
  if (width * height < MIN_PAGE_PIXELS || Math.min(width, height) < MIN_PAGE_EDGE_PIXELS) {
    return "too_small";
  }
  if (quality.stdDev < MIN_CONTENT_STDDEV) return "blank";
  if (quality.sharpness < MIN_SHARPNESS_VARIANCE) return "blurry";
  return null;
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the page."))),
      "image/jpeg",
      PAGE_JPEG_QUALITY,
    );
  });
}

function toJpegName(name: string): string {
  const base = (name || "page").replace(/\.[^.]+$/, "");
  return `${base || "page"}.jpg`;
}
