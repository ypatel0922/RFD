/**
 * Dependency-free image inspection.
 *
 * Reads pixel dimensions straight out of the file header for the formats a phone
 * produces. This is a server-side guard against a page that could never be read:
 * a blank capture, a thumbnail, or a truncated upload. It avoids a native image
 * library so the route stays deployable on any serverless runtime.
 *
 * A corresponding, richer check runs in the browser before upload (see
 * `lib/reconciliation/client/image-prep.ts`); this one is the backstop that
 * cannot be bypassed by a crafted request.
 */

import { MIN_PAGE_EDGE_PIXELS, MIN_PAGE_PIXELS } from "../config";

export type ImageDimensions = { width: number; height: number };

export type InspectionResult =
  | { kind: "ok"; format: "jpeg" | "png" | "webp" | "pdf" | "heic"; dimensions: ImageDimensions | null }
  | { kind: "unreadable"; reason: string };

export function inspectPageBytes(bytes: Buffer, declaredMimeType: string): InspectionResult {
  if (bytes.length < 64) {
    return { kind: "unreadable", reason: "That file is empty or was cut off during upload." };
  }

  if (isPdf(bytes)) {
    // A single-page PDF is text or vector data; pixel dimensions do not apply.
    return { kind: "ok", format: "pdf", dimensions: null };
  }

  if (isJpeg(bytes)) {
    const dimensions = jpegDimensions(bytes);
    return finish("jpeg", dimensions);
  }

  if (isPng(bytes)) {
    return finish("png", pngDimensions(bytes));
  }

  if (isWebp(bytes)) {
    return finish("webp", webpDimensions(bytes));
  }

  if (isHeic(bytes)) {
    // HEIC dimensions live in a nested metadata box. The browser converts phone
    // photos to JPEG before upload, so reaching here means the conversion was
    // skipped; accept it and let the provider decide.
    return { kind: "ok", format: "heic", dimensions: null };
  }

  return {
    kind: "unreadable",
    reason: `That file type (${declaredMimeType || "unknown"}) is not a statement photo or PDF.`,
  };
}

function finish(
  format: "jpeg" | "png" | "webp",
  dimensions: ImageDimensions | null,
): InspectionResult {
  if (!dimensions) {
    return { kind: "unreadable", reason: "That image file is damaged and could not be opened." };
  }
  if (dimensions.width < MIN_PAGE_EDGE_PIXELS || dimensions.height < MIN_PAGE_EDGE_PIXELS) {
    return {
      kind: "unreadable",
      reason: "That image is too small to read statement text. Take the photo closer to the page.",
    };
  }
  if (dimensions.width * dimensions.height < MIN_PAGE_PIXELS) {
    return {
      kind: "unreadable",
      reason: "That image is too low resolution to read statement text. Retake the photo.",
    };
  }
  return { kind: "ok", format, dimensions };
}

function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

function isJpeg(bytes: Buffer): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isWebp(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

function isHeic(bytes: Buffer): boolean {
  if (bytes.subarray(4, 8).toString("latin1") !== "ftyp") return false;
  const brand = bytes.subarray(8, 12).toString("latin1");
  return ["heic", "heix", "hevc", "heim", "heis", "hevm", "mif1", "msf1"].includes(brand);
}

/** Walk JPEG markers to the first Start-Of-Frame segment, which holds the size. */
function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];

    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;

    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }

    offset += 2 + length;
  }
  return null;
}

function pngDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  const chunk = bytes.subarray(12, 16).toString("latin1");

  if (chunk === "VP8X" && bytes.length >= 30) {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }

  if (chunk === "VP8 " && bytes.length >= 30) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }

  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }

  return null;
}
