import { describe, expect, it } from "vitest";
import { MAIL_TEMPLATE_DEFAULTS, SYSTEM_EMAIL_SLOTS, validateMailTemplate } from "./mail-templates.js";

describe("system email defaults", () => {
  it.each(SYSTEM_EMAIL_SLOTS)("%s is a valid template", (slot) => {
    expect(validateMailTemplate(slot, MAIL_TEMPLATE_DEFAULTS[slot])).toBeNull();
  });

  // The admin edits these in a rich-text editor that keeps only semantic
  // HTML - an inline style or layout wrapper here would be dropped on the
  // first edit. The layout is applied at render time instead.
  it.each(SYSTEM_EMAIL_SLOTS)("%s has no inline styles or layout wrapper in its HTML body", (slot) => {
    const { html } = MAIL_TEMPLATE_DEFAULTS[slot];
    expect(html).not.toMatch(/style=|<div/);
  });
});
