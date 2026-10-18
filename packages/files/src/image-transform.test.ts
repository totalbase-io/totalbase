import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { readImageDimensions, transformImage } from "./image-transform.js";

async function testImage(width = 200, height = 100): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .png()
    .toBuffer();
}

describe("transformImage", () => {
  it("resizes with the requested fit and never upscales beyond the original", async () => {
    const source = await testImage(200, 100);
    const result = await transformImage(source, { width: 100, height: 50, fit: "cover" }, 5000);
    expect(result.width).toBe(100);
    expect(result.height).toBe(50);

    // Requesting larger than the original must not upscale.
    const noUpscale = await transformImage(source, { width: 400, height: 400, fit: "inside" }, 5000);
    expect(noUpscale.width).toBeLessThanOrEqual(200);
    expect(noUpscale.height).toBeLessThanOrEqual(200);
  });

  it("converts format and reports the matching content type", async () => {
    const source = await testImage();
    const result = await transformImage(source, { format: "webp" }, 5000);
    expect(result.contentType).toBe("image/webp");
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.format).toBe("webp");
  });

  it("rotates by the requested angle", async () => {
    const source = await testImage(200, 100);
    const result = await transformImage(source, { rotate: 90 }, 5000);
    // A 90-degree rotation swaps width/height.
    expect(result.width).toBe(100);
    expect(result.height).toBe(200);
  });

  it("flips horizontally and vertically without error", async () => {
    const source = await testImage();
    await expect(transformImage(source, { flip: "horizontal" }, 5000)).resolves.toBeDefined();
    await expect(transformImage(source, { flip: "vertical" }, 5000)).resolves.toBeDefined();
  });

  it("applies blur and sharpen without error", async () => {
    const source = await testImage();
    await expect(transformImage(source, { blur: 5 }, 5000)).resolves.toBeDefined();
    await expect(transformImage(source, { sharpen: true }, 5000)).resolves.toBeDefined();
  });

  it("preserves the original format when neither format nor quality is requested", async () => {
    const source = await testImage(); // PNG
    const result = await transformImage(source, { width: 50 }, 5000);
    expect(result.contentType).toBe("image/png");
  });

  it("follows the deterministic pipeline order - rotate then resize means final dimensions reflect both", async () => {
    const source = await testImage(200, 100);
    // Rotate 90 (-> 100x200) then constrain to width=50 with fit inside.
    const result = await transformImage(source, { rotate: 90, width: 50, fit: "inside" }, 5000);
    expect(result.width).toBeLessThanOrEqual(50);
  });

  it("crops a region before resizing", async () => {
    const source = await testImage(200, 100);
    const result = await transformImage(source, { crop: { left: 10, top: 10, width: 50, height: 50 } }, 5000);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });

  it("converts to grayscale", async () => {
    // A non-gray source (distinct R/G/B) so grayscale conversion is
    // actually observable rather than a no-op on already-gray pixels.
    const source = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 220, g: 40, b: 10 } } })
      .png()
      .toBuffer();
    const result = await transformImage(source, { grayscale: true }, 5000);
    const stats = await sharp(result.buffer).stats();
    // Grayscale collapses R/G/B down to the same value per pixel,
    // regardless of whether the encoder keeps 3 channels or reduces to 1.
    expect(stats.channels[0]!.mean).toBeCloseTo(stats.channels[1]!.mean, 0);
    expect(stats.channels[1]!.mean).toBeCloseTo(stats.channels[stats.channels.length > 2 ? 2 : 1]!.mean, 0);
  });

  it("rejects a corrupt/non-image buffer with TRANSFORM_FAILED", async () => {
    await expect(transformImage(Buffer.from("not an image"), { width: 100 }, 5000)).rejects.toMatchObject({
      code: "TRANSFORM_FAILED",
    });
  });
});

describe("readImageDimensions", () => {
  it("reads width/height from a real image", async () => {
    const source = await testImage(321, 123);
    const dimensions = await readImageDimensions(source);
    expect(dimensions).toEqual({ width: 321, height: 123 });
  });
});
