import { describe, expect, it } from "vitest";
import { address, MAX_RECIPIENTS_PER_STEP } from "./email-handlers.js";

/** Send email's to / cc / bcc (Workflows.md §5.16): one address, a comma-separated string, or a list. */
describe("Send email recipients", () => {
  it("takes a string or a list - a list comma-joined", () => {
    expect(address(" ana@example.com ")).toBe("ana@example.com");
    expect(address(["ana@example.com", " bo@example.com ", ""])).toBe("ana@example.com, bo@example.com");
  });

  it("reads an empty value as none, and refuses a list of anything but text", () => {
    expect(address([])).toBeUndefined();
    expect(address("  ")).toBeUndefined();
    expect(() => address(["ana@example.com", { email: "bo@example.com" }])).toThrow(/email addresses only/);
  });

  // Security regression: a recipient taken from a webhook's body was handed to the mail relay as it came - any number
  // of addresses, or text that wasn't one. Each is an address now, and a step has a recipient cap.
  it("refuses what isn't an email address, in a string or a list", () => {
    expect(address("Ana <ana@example.com>, bo@example.com")).toBe("Ana <ana@example.com>, bo@example.com");
    for (const bad of ["not-an-address", "ana@example.com\r\nBcc: x@evil.test", ["ana@example.com", "two words@x"], "a@b"]) {
      expect(() => address(bad), JSON.stringify(bad)).toThrow(/Not an email address/);
    }
    expect(MAX_RECIPIENTS_PER_STEP).toBe(50);
  });
});
