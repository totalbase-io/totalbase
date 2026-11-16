import { MAIL_TEMPLATE_DEFAULTS } from "@totalbase/settings";
import { describe, expect, it } from "vitest";
import { renderMailTemplate } from "./system-mailer.js";

const variables = {
  "user.name": "Ana <admin>",
  "instance.name": "Acme",
  "instance.public_url": "https://acme.example.com",
  action_url: "https://acme.example.com/accept?token=abc",
};

describe("renderMailTemplate", () => {
  // mail.footer (Administration.md §8.3)
  describe("the footer", () => {
    const template = { subject: "s", html: "<p>x</p>", text: "t" };
    const values = { "instance.name": "Acme & Co", "instance.public_url": "https://base.internal" };

    it("is the instance's name and address by default", () => {
      expect(renderMailTemplate(template, values).html).toContain(">Acme &amp; Co · https://base.internal</p>");
    });

    it("is the setting's text, its variables filled and escaped", () => {
      const email = renderMailTemplate(template, values, "Sent by {{instance.name}} <support>");
      expect(email.html).toContain(">Sent by Acme &amp; Co &lt;support&gt;</p>");
      expect(email.html).not.toContain("base.internal");
    });

    it("is left out when empty - no paragraph, and never in the plain text", () => {
      const email = renderMailTemplate(template, values, "  ");
      expect(email.html).toBe(renderMailTemplate(template, values).html.replace(/\n<p style="margin-top:32px[^\n]*<\/p>/, ""));
      expect(email.html).not.toContain("margin-top:32px");
      expect(email.text).toBe("t");
    });
  });

  it("centers its frame", () => {
    const email = renderMailTemplate({ subject: "s", html: "<p>x</p>", text: "" }, { "instance.name": "Acme" });
    expect(email.html).toMatch(/^<div style="[^"]*max-width:520px;margin:0 auto"/);
  });

  it("wraps a non-empty HTML body in the layout, with an escaped instance footer", () => {
    const email = renderMailTemplate(
      { subject: "Hi {{user.name}}", html: "<p>Hi {{user.name}}</p>", text: "Hi {{user.name}}" },
      variables,
    );
    expect(email.html).toMatch(/^<div style="font-family:/);
    expect(email.html).toContain("<p>Hi Ana &lt;admin&gt;</p>");
    expect(email.html).toContain("Acme · https://acme.example.com</p>");
    // Subject and plain text are not HTML: neither escaped nor wrapped.
    expect(email.subject).toBe("Hi Ana <admin>");
    expect(email.text).toBe("Hi Ana <admin>");
  });

  it("leaves an empty HTML body empty - a text-only email stays text-only", () => {
    const email = renderMailTemplate({ subject: "s", html: "  ", text: "t" }, variables);
    expect(email.html).toBe("");
  });

  it("drops a missing footer part instead of rendering a dangling separator", () => {
    const email = renderMailTemplate({ subject: "s", html: "<p>x</p>", text: "" }, { "instance.name": "Acme" });
    expect(email.html).toContain(">Acme</p>");
    expect(email.html).not.toContain(" · ");
  });

  it("tells the previous address what it changed to (email_changed)", () => {
    const email = renderMailTemplate(MAIL_TEMPLATE_DEFAULTS.email_changed, {
      ...variables,
      "user.email": "old@example.com",
      new_email: "new@example.com",
    });
    expect(email.text).toContain("from old@example.com to new@example.com");
    expect(email.html).toContain("<strong>old@example.com</strong> to <strong>new@example.com</strong>");
  });
});
