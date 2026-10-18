import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signCms } from "./sign-handlers.js";

/**
 * Sign (Specification_Workflows.md §5.15.2): the SignedData is checked by
 * OpenSSL itself - the signature, the attached content - the way the
 * service receiving it would.
 */
describe("signCms", () => {
  let dir: string;
  const pem = (name: string) => readFileSync(join(dir, name), "utf8");
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  const names = { certificate: "cert", privateKey: "key" };
  const TICKET = '<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>1</uniqueId></header><service>ws_sr_padron_a13</service></loginTicketRequest>';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-sign-"));
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", "30", "-subj", "/CN=totalbase-test/serialNumber=CUIT 20123456789");
    openssl("genrsa", "-out", "other.pem", "2048");
    openssl("pkey", "-in", "key.pem", "-out", "encrypted.pem", "-aes256", "-passout", "pass:s3cret");
    openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", "ec.pem");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("produces an attached CMS SignedData OpenSSL verifies, carrying the content", () => {
    const result = signCms(TICKET, pem("cert.pem"), pem("key.pem"), undefined, names);
    expect(result.format).toBe("CMS");
    expect(result.certificate.subject).toContain("CN=totalbase-test");
    writeFileSync(join(dir, "signed.der"), Buffer.from(result.signature, "base64"));
    const content = openssl("cms", "-verify", "-inform", "DER", "-in", "signed.der", "-noverify").toString("utf8");
    expect(content).toBe(TICKET);
  });

  it("reads a key encrypted with a passphrase", () => {
    const result = signCms("hola", pem("cert.pem"), pem("encrypted.pem"), "s3cret", names);
    writeFileSync(join(dir, "signed2.der"), Buffer.from(result.signature, "base64"));
    expect(openssl("cms", "-verify", "-inform", "DER", "-in", "signed2.der", "-noverify").toString("utf8")).toBe("hola");
  });

  it("refuses, naming the secret and never its content: not PEM, a wrong passphrase, a key that isn't the certificate's, a non-RSA key, an expired certificate", () => {
    const attempt = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error as { code: string; message: string };
      }
      throw new Error("expected a failure");
    };
    expect(attempt(() => signCms("x", "not a pem", pem("key.pem"), undefined, names))).toMatchObject({ code: "WORKFLOW_SIGN_FAILED", message: expect.stringContaining('"cert" is not a PEM certificate') });
    expect(attempt(() => signCms("x", pem("cert.pem"), "garbage", undefined, names)).message).toContain('"key" is not a PEM private key');
    expect(attempt(() => signCms("x", pem("cert.pem"), pem("encrypted.pem"), "wrong", names)).message).toContain("passphrase is wrong");
    expect(attempt(() => signCms("x", pem("cert.pem"), pem("other.pem"), undefined, names)).message).toContain("are not a pair");
    expect(attempt(() => signCms("x", pem("cert.pem"), pem("ec.pem"), undefined, names)).message).toContain("takes an RSA key");
    const expired = attempt(() => signCms("x", pem("cert.pem"), pem("key.pem"), undefined, names, new Date(Date.now() + 60 * 86_400_000)));
    expect(expired.message).toContain("expired on");
    expect(expired.message).not.toContain("PRIVATE KEY");
  });
});
