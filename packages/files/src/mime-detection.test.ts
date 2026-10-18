import { describe, expect, it } from "vitest";
import { detectMimeType } from "./mime-detection.js";

describe("detectMimeType", () => {
  it("detects PNG by signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectMimeType(png)).toBe("image/png");
  });

  it("detects JPEG by signature", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(detectMimeType(jpeg)).toBe("image/jpeg");
  });

  it("detects GIF87a and GIF89a", () => {
    expect(detectMimeType(Buffer.from("GIF87a", "ascii"))).toBe("image/gif");
    expect(detectMimeType(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
  });

  it("detects WEBP via RIFF container", () => {
    const webp = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "ascii")]);
    expect(detectMimeType(webp)).toBe("image/webp");
  });

  it("does not confuse a plain RIFF/WAV file for WEBP", () => {
    const wav = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE", "ascii")]);
    expect(detectMimeType(wav)).toBeUndefined();
  });

  it("detects PDF by signature", () => {
    expect(detectMimeType(Buffer.from("%PDF-1.4\n", "ascii"))).toBe("application/pdf");
  });

  it("returns undefined for an unrecognized signature (client Content-Type must not be blindly trusted, but this module has a documented narrow scope)", () => {
    expect(detectMimeType(Buffer.from("not a real file", "ascii"))).toBeUndefined();
  });

  it("does not false-positive a PNG signature disguised with a fake extension's declared type - detection is purely byte-based", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    // Even if a caller declares Content-Type: image/png with a .png filename,
    // the actual bytes say JPEG.
    expect(detectMimeType(jpeg)).toBe("image/jpeg");
  });
});
