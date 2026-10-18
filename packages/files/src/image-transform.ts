import sharp from "sharp";
import { TotalBaseError } from "@totalbase/errors";
import type { TransformParams } from "./transform-params.js";

export interface TransformResult {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
};

/**
 * Applies the deterministic transformation pipeline, ported from
 * @totalbase/assets: decode -> orientation/rotate/flip -> resize/crop/fit
 * -> blur/sharpen -> format/quality -> encode. `sharp(...).rotate()` with
 * no argument auto-orients from EXIF before any explicit user rotation is
 * applied - this always runs, independent of whether the caller requested
 * a rotation, so a sideways photo is never served sideways by accident.
 */
export async function transformImage(source: Buffer, params: TransformParams, timeoutMs: number): Promise<TransformResult> {
  try {
    const metadata = await sharp(source).metadata();
    const sourceFormat = metadata.format;

    let pipeline = sharp(source, { failOn: "none" })
      .timeout({ seconds: Math.max(1, Math.round(timeoutMs / 1000)) })
      .rotate(); // auto-orient from EXIF

    if (params.rotate) pipeline = pipeline.rotate(params.rotate);
    if (params.flip === "vertical") pipeline = pipeline.flip();
    if (params.flip === "horizontal") pipeline = pipeline.flop();

    // Crop happens before resize - the region is selected against the
    // (already rotated/flipped) source, and width/height below then
    // apply to that cropped region rather than the full original.
    if (params.crop) {
      pipeline = pipeline.extract({
        left: params.crop.left,
        top: params.crop.top,
        width: params.crop.width,
        height: params.crop.height,
      });
    }

    // Dynamic transformations never upscale beyond the original -
    // withoutEnlargement handles this regardless of which of width/height
    // was actually given.
    if (params.width !== undefined || params.height !== undefined) {
      pipeline = pipeline.resize({
        width: params.width,
        height: params.height,
        fit: params.fit ?? "cover",
        withoutEnlargement: true,
      });
    }

    if (params.grayscale) pipeline = pipeline.grayscale();
    if (params.blur !== undefined) pipeline = pipeline.blur(params.blur);
    if (params.sharpen) pipeline = pipeline.sharpen();

    const targetFormat = params.format ?? (isSupportedOutputFormat(sourceFormat) ? sourceFormat : undefined);
    if (targetFormat && (params.format !== undefined || params.quality !== undefined)) {
      pipeline = pipeline.toFormat(targetFormat, params.quality !== undefined ? { quality: params.quality } : undefined);
    }

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      buffer: data,
      contentType: FORMAT_CONTENT_TYPES[info.format] ?? "application/octet-stream",
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (error instanceof TotalBaseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // sharp's own timeout option rejects with a message containing
    // "timeout" - distinguish it from a generic processing failure.
    if (/timeout/i.test(message)) {
      throw new TotalBaseError("TRANSFORM_TIMEOUT", "Image transformation timed out.");
    }
    throw new TotalBaseError("TRANSFORM_FAILED", `Image transformation failed: ${message}`);
  }
}

function isSupportedOutputFormat(format: string | undefined): format is "jpeg" | "png" | "webp" | "avif" {
  return format === "jpeg" || format === "png" || format === "webp" || format === "avif";
}

/** Reads width/height only, without transforming - used at upload time. */
export async function readImageDimensions(source: Buffer): Promise<{ width: number | null; height: number | null }> {
  const metadata = await sharp(source).metadata();
  return { width: metadata.width ?? null, height: metadata.height ?? null };
}
