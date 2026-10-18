import { describe, expect, it } from "vitest";
import { parseTransformParams, transformCacheKey } from "./transform-params.js";

const LIMITS = { maxWidth: 4096, maxHeight: 4096, maxPixels: 16_000_000, maxOperations: 6 };

describe("parseTransformParams", () => {
  it("returns undefined when no transform query params are present", () => {
    expect(parseTransformParams({ query: {}, presets: {}, ...LIMITS })).toBeUndefined();
    expect(parseTransformParams({ query: { format_x: "y" }, presets: {}, ...LIMITS })).toBeUndefined();
  });

  it("parses width/height/fit", () => {
    const params = parseTransformParams({
      query: { width: "300", height: "300", fit: "cover" },
      presets: {},
      ...LIMITS,
    });
    expect(params).toEqual({ width: 300, height: 300, fit: "cover" });
  });

  it("rejects an invalid fit value", () => {
    expect(() => parseTransformParams({ query: { fit: "sideways" }, presets: {}, ...LIMITS })).toThrow(
      /INVALID_TRANSFORM_PARAMS|Invalid fit/,
    );
  });

  it("rejects width/height above the configured maximum", () => {
    expect(() =>
      parseTransformParams({ query: { width: "50000", height: "50000" }, presets: {}, ...LIMITS }),
    ).toThrow();
  });

  it("rejects a pixel count above the configured maximum even if each dimension individually is within bounds", () => {
    // 4090 * 4090 = 16,728,100 > 16,000,000 max, while each dimension alone (4090) stays under maxWidth/maxHeight (4096).
    expect(() =>
      parseTransformParams({ query: { width: "4090", height: "4090" }, presets: {}, ...LIMITS }),
    ).toThrow(/exceed the configured maximum pixel count/);
  });

  it("rejects negative or zero dimensions", () => {
    expect(() => parseTransformParams({ query: { width: "0" }, presets: {}, ...LIMITS })).toThrow();
    expect(() => parseTransformParams({ query: { width: "-10" }, presets: {}, ...LIMITS })).toThrow();
  });

  it("restricts rotate to 0/90/180/270", () => {
    expect(parseTransformParams({ query: { rotate: "90" }, presets: {}, ...LIMITS })).toEqual({ rotate: 90 });
    expect(() => parseTransformParams({ query: { rotate: "45" }, presets: {}, ...LIMITS })).toThrow();
  });

  it("validates quality range 1-100", () => {
    expect(parseTransformParams({ query: { quality: "80" }, presets: {}, ...LIMITS })).toEqual({ quality: 80 });
    expect(() => parseTransformParams({ query: { quality: "0" }, presets: {}, ...LIMITS })).toThrow();
    expect(() => parseTransformParams({ query: { quality: "101" }, presets: {}, ...LIMITS })).toThrow();
  });

  it("expands a named preset and allows overriding individual fields", () => {
    const presets = { thumbnail: { width: 150, height: 150, fit: "cover" as const, format: "webp" as const, quality: 80 } };
    const params = parseTransformParams({ query: { preset: "thumbnail" }, presets, ...LIMITS });
    expect(params).toEqual(presets.thumbnail);

    const overridden = parseTransformParams({ query: { preset: "thumbnail", quality: "50" }, presets, ...LIMITS });
    expect(overridden).toEqual({ ...presets.thumbnail, quality: 50 });
  });

  it("rejects an unknown preset name", () => {
    expect(() => parseTransformParams({ query: { preset: "does-not-exist" }, presets: {}, ...LIMITS })).toThrow(
      /Unknown transformation preset/,
    );
  });

  it("rejects when too many operations are requested", () => {
    expect(() =>
      parseTransformParams({
        query: { width: "10", height: "10", fit: "cover", format: "webp", quality: "80", rotate: "90", flip: "horizontal" },
        presets: {},
        maxWidth: 4096,
        maxHeight: 4096,
        maxPixels: 16_000_000,
        maxOperations: 3,
      }),
    ).toThrow(/Too many transformation operations/);
  });

  it("parses a complete crop region as a single operation", () => {
    const params = parseTransformParams({
      query: { cropLeft: "10", cropTop: "20", cropWidth: "100", cropHeight: "50" },
      presets: {},
      ...LIMITS,
    });
    expect(params).toEqual({ crop: { left: 10, top: 20, width: 100, height: 50 } });
  });

  it("rejects a partial crop region", () => {
    expect(() =>
      parseTransformParams({ query: { cropLeft: "10", cropTop: "20" }, presets: {}, ...LIMITS }),
    ).toThrow(/must all be given together/);
  });

  it("rejects a crop region above the configured maximum", () => {
    expect(() =>
      parseTransformParams({
        query: { cropLeft: "0", cropTop: "0", cropWidth: "50000", cropHeight: "50000" },
        presets: {},
        ...LIMITS,
      }),
    ).toThrow();
  });

  it("parses grayscale", () => {
    expect(parseTransformParams({ query: { grayscale: "true" }, presets: {}, ...LIMITS })).toEqual({ grayscale: true });
    expect(() => parseTransformParams({ query: { grayscale: "yes" }, presets: {}, ...LIMITS })).toThrow();
  });
});

describe("transformCacheKey", () => {
  it("is independent of query parameter order", () => {
    const a = transformCacheKey("file-1", "hash-1", { width: 300, format: "webp" });
    const b = transformCacheKey("file-1", "hash-1", { format: "webp", width: 300 });
    expect(a).toBe(b);
  });

  it("changes when the source hash changes", () => {
    const a = transformCacheKey("file-1", "hash-1", { width: 300 });
    const b = transformCacheKey("file-1", "hash-2", { width: 300 });
    expect(a).not.toBe(b);
  });

  it("changes when the file id changes", () => {
    const a = transformCacheKey("file-1", "hash-1", { width: 300 });
    const b = transformCacheKey("file-2", "hash-1", { width: 300 });
    expect(a).not.toBe(b);
  });
});
