import { describe, expect, it } from "vitest";
import { flattenTemplateData, renderMailingTemplate } from "./email-handlers.js";
import { OPERATION_HANDLERS } from "./handlers.js";
import { isAddressAllowed, outboundPolicy } from "./http-client.js";
import type { RunState } from "./bindings.js";
import { resolveTemplates } from "./templates.js";
import type { HandlerArgs } from "./types.js";

describe("HTTP request outbound policy", () => {
  const none = outboundPolicy([]);

  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1",
  ])("refuses %s", (address) => {
    expect(isAddressAllowed(address, none)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("allows public %s", (address) => {
    expect(isAddressAllowed(address, none)).toBe(true);
  });

  it("exempts listed addresses and CIDR ranges, and records hostnames", () => {
    const policy = outboundPolicy(["10.0.0.0/8", "127.0.0.1", "Internal.Example"]);
    expect(isAddressAllowed("10.9.9.9", policy)).toBe(true);
    expect(isAddressAllowed("127.0.0.1", policy)).toBe(true);
    expect(isAddressAllowed("127.0.0.2", policy)).toBe(false);
    expect(policy.hostnames.has("internal.example")).toBe(true);
  });
});

describe("Validate data", () => {
  const triggerData = { email: "a@example.com", total: 0 };
  const state = { triggerData, results: new Map(), resultsByKey: new Map([["start", { data: triggerData }]]) } as RunState;
  // The engine resolves the configuration's {{...}} templates before the handler runs (TEMPLATED_OPERATION_TYPES).
  const validate = (configuration: Record<string, unknown>) =>
    OPERATION_HANDLERS["totalbase.validate-data"]!({ configuration: resolveTemplates(configuration, state), state } as unknown as HandlerArgs);

  it("passes the input on next when every rule holds", async () => {
    await expect(validate({ input: { a: 1 }, rules: [{ filter: { a: { _eq: "1" } }, message: "a must be 1" }] }))
      .resolves.toEqual({ output: "next", result: { a: 1 } });
  });

  it("resolves {{...}} templates and lists every failed rule", async () => {
    await expect(validate({
      input: "{{start.data}}",
      rules: [
        { filter: { email: { _nnull: true } }, message: "Email is required." },
        { filter: { total: { _gt: "0" } }, message: "Total must be positive." },
        { filter: { email: { _ilike: "%@other.com" } } },
      ],
    })).rejects.toMatchObject({ code: "WORKFLOW_VALIDATION_FAILED", message: "Validation failed: Total must be positive.; Rule 3 failed." });
  });

  it("rejects rules that are not a list", async () => {
    await expect(validate({ input: {}, rules: { a: { _eq: "1" } } })).rejects.toMatchObject({ code: "WORKFLOW_INVALID_DESIGN" });
  });
});

describe("MAILING template rendering", () => {
  it("flattens data into dotted variables", () => {
    expect(flattenTemplateData({ customer: { name: "Ana", tags: ["a"] }, total: 3, none: null })).toEqual({
      customer: JSON.stringify({ name: "Ana", tags: ["a"] }), "customer.name": "Ana", "customer.tags": '["a"]', total: "3",
    });
  });

  it("fills subject and message, escaping the message only", () => {
    expect(renderMailingTemplate({ subject: "Hi {{name}}", message: "<p>{{ name }}</p>" }, { name: "<A&B>" }))
      .toEqual({ subject: "Hi <A&B>", html: "<p>&lt;A&amp;B&gt;</p>" });
  });

  it("fails with MISSING_TEMPLATE_VARIABLES instead of rendering a blank", () => {
    expect(() => renderMailingTemplate({ subject: "{{a}}", message: "{{b.c}}" }, { a: "x" })).toThrow(expect.objectContaining({ code: "MISSING_TEMPLATE_VARIABLES" }));
  });
});
