import { createHash } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";

/**
 * Dynamic image transformation parameters, ported from @totalbase/assets.
 * Deliberately the small, fixed set assets already allows - no arbitrary
 * pipeline, no exposed low-level image-library options.
 */
export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TransformParams {
  width?: number;
  height?: number;
  fit?: "cover" | "contain" | "inside";
  format?: "jpeg" | "png" | "webp" | "avif";
  quality?: number;
  rotate?: 0 | 90 | 180 | 270;
  flip?: "horizontal" | "vertical";
  crop?: CropRegion;
  grayscale?: boolean;
  blur?: number;
  sharpen?: boolean;
}

export type TransformPreset = TransformParams;

const FIT_VALUES = new Set(["cover", "contain", "inside"]);
const FORMAT_VALUES = new Set(["jpeg", "png", "webp", "avif"]);
const ROTATE_VALUES = new Set([0, 90, 180, 270]);
const FLIP_VALUES = new Set(["horizontal", "vertical"]);

// Sharp's own usable sigma range is roughly 0.3-1000; kept as a
// conservative fixed bound rather than yet another setting, same as
// @totalbase/assets.
const BLUR_MIN = 0.3;
const BLUR_MAX = 100;

const RECOGNIZED_KEYS = [
  "width",
  "height",
  "fit",
  "format",
  "quality",
  "rotate",
  "flip",
  "cropLeft",
  "cropTop",
  "cropWidth",
  "cropHeight",
  "grayscale",
  "blur",
  "sharpen",
  "preset",
] as const;

export interface ParseTransformParamsOptions {
  query: Record<string, string | undefined>;
  presets: Record<string, TransformPreset>;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  maxOperations: number;
}

function parseInt10(value: string, field: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== value.trim()) {
    throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", `Invalid ${field}: ${value}`);
  }
  return n;
}

/**
 * Returns `undefined` when no transformation query parameters are present
 * at all - the plain content endpoint remains the original, unmodified
 * file. Throws on any recognized-but-invalid parameter, and validates
 * resource limits before returning.
 */
export function parseTransformParams(options: ParseTransformParamsOptions): TransformParams | undefined {
  const { query } = options;
  const present = RECOGNIZED_KEYS.filter((key) => query[key] !== undefined);
  if (present.length === 0) return undefined;

  let params: TransformParams;
  if (query.preset !== undefined) {
    const preset = options.presets[query.preset];
    if (!preset) {
      throw new TotalBaseError("TRANSFORM_PRESET_NOT_FOUND", `Unknown transformation preset: ${query.preset}`);
    }
    params = { ...preset };
  } else {
    params = {};
  }

  if (query.width !== undefined) params.width = parseInt10(query.width, "width");
  if (query.height !== undefined) params.height = parseInt10(query.height, "height");
  if (query.fit !== undefined) {
    if (!FIT_VALUES.has(query.fit)) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", `Invalid fit: ${query.fit}`);
    params.fit = query.fit as "cover" | "contain" | "inside";
  }
  if (query.format !== undefined) {
    if (!FORMAT_VALUES.has(query.format)) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", `Invalid format: ${query.format}`);
    params.format = query.format as "jpeg" | "png" | "webp" | "avif";
  }
  if (query.quality !== undefined) {
    const quality = parseInt10(query.quality, "quality");
    if (quality < 1 || quality > 100) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "quality must be between 1 and 100");
    params.quality = quality;
  }
  if (query.rotate !== undefined) {
    const rotate = parseInt10(query.rotate, "rotate");
    if (!ROTATE_VALUES.has(rotate)) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "rotate must be one of 0, 90, 180, 270");
    params.rotate = rotate as 0 | 90 | 180 | 270;
  }
  if (query.flip !== undefined) {
    if (!FLIP_VALUES.has(query.flip)) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "flip must be 'horizontal' or 'vertical'");
    params.flip = query.flip as "horizontal" | "vertical";
  }
  const cropKeys = ["cropLeft", "cropTop", "cropWidth", "cropHeight"] as const;
  const cropPresent = cropKeys.filter((key) => query[key] !== undefined);
  if (cropPresent.length > 0) {
    if (cropPresent.length !== cropKeys.length) {
      throw new TotalBaseError(
        "INVALID_TRANSFORM_PARAMS",
        "cropLeft, cropTop, cropWidth, and cropHeight must all be given together",
      );
    }
    const left = parseInt10(query.cropLeft!, "cropLeft");
    const top = parseInt10(query.cropTop!, "cropTop");
    const width = parseInt10(query.cropWidth!, "cropWidth");
    const height = parseInt10(query.cropHeight!, "cropHeight");
    if (left < 0 || top < 0) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "cropLeft/cropTop must not be negative");
    if (width <= 0 || height <= 0) throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "cropWidth/cropHeight must be positive");
    if (width > options.maxWidth || height > options.maxHeight) {
      throw new TotalBaseError("TRANSFORM_DIMENSIONS_TOO_LARGE", "crop region exceeds the configured maximum dimensions");
    }
    if (width * height > options.maxPixels) {
      throw new TotalBaseError("TRANSFORM_DIMENSIONS_TOO_LARGE", "crop region exceeds the configured maximum pixel count");
    }
    params.crop = { left, top, width, height };
  }

  if (query.grayscale !== undefined) {
    if (query.grayscale !== "true" && query.grayscale !== "false") {
      throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "grayscale must be 'true' or 'false'");
    }
    params.grayscale = query.grayscale === "true";
  }

  if (query.blur !== undefined) {
    const blur = Number.parseFloat(query.blur);
    if (!Number.isFinite(blur) || blur < BLUR_MIN || blur > BLUR_MAX) {
      throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", `blur must be between ${BLUR_MIN} and ${BLUR_MAX}`);
    }
    params.blur = blur;
  }
  if (query.sharpen !== undefined) {
    if (query.sharpen !== "true" && query.sharpen !== "false") {
      throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "sharpen must be 'true' or 'false'");
    }
    params.sharpen = query.sharpen === "true";
  }

  const operationCount = Object.values(params).filter((v) => v !== undefined).length;
  if (operationCount > options.maxOperations) {
    throw new TotalBaseError(
      "INVALID_TRANSFORM_PARAMS",
      `Too many transformation operations requested (max ${options.maxOperations})`,
    );
  }

  if (params.width !== undefined && params.width > options.maxWidth) {
    throw new TotalBaseError("TRANSFORM_DIMENSIONS_TOO_LARGE", `width exceeds the configured maximum of ${options.maxWidth}`);
  }
  if (params.height !== undefined && params.height > options.maxHeight) {
    throw new TotalBaseError("TRANSFORM_DIMENSIONS_TOO_LARGE", `height exceeds the configured maximum of ${options.maxHeight}`);
  }
  if (params.width !== undefined && params.height !== undefined && params.width * params.height > options.maxPixels) {
    throw new TotalBaseError("TRANSFORM_DIMENSIONS_TOO_LARGE", `requested dimensions exceed the configured maximum pixel count`);
  }
  if ((params.width !== undefined && params.width <= 0) || (params.height !== undefined && params.height <= 0)) {
    throw new TotalBaseError("INVALID_TRANSFORM_PARAMS", "width/height must be positive");
  }

  return params;
}

/** Where derivatives live in storage: `derivatives/<file id>/<digest>` - one folder per file, so a deleted file's derivatives go with one prefix delete. */
export const DERIVATIVES_PREFIX = "derivatives";

/**
 * Canonical cache key: depends on file id, source checksum, and
 * normalized transform params - independent of query parameter order,
 * since `params` is a plain object serialized with sorted keys.
 */

export function transformCacheKey(fileId: string, sourceHash: string, params: TransformParams): string {
  const normalized = Object.keys(params)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = (params as Record<string, unknown>)[key];
      return acc;
    }, {});
  const digest = createHash("sha256")
    .update(fileId)
    .update(sourceHash)
    .update(JSON.stringify(normalized))
    .digest("hex");
  return `${DERIVATIVES_PREFIX}/${fileId}/${digest}`;
}
