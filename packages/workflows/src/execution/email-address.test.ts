import { describe, expect, it } from "vitest";
import { address } from "./email-handlers.js";

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
});
