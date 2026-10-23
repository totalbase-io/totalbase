import { createHmac, createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";
import forge from "node-forge";
import type { OperationHandler } from "./types.js";

/**
 * Sign (Workflows.md §5.15.2): signs a text with a certificate
 * and its private key kept in `totalbase.secrets`, read when the step runs -
 * never in the definition, a version or the history. Two formats: `CMS`, a
 * PKCS#7/CMS SignedData with the content attached, the certificate included,
 * SHA-256, DER, base64 - what `openssl cms -sign -nodetach -outform DER`
 * produces, and what a WSAA-style login (AFIP) takes; and `HMAC_SHA256`, a
 * keyed hash with a secret as its key - a webhook's signature, or a
 * pseudonym that only the secret's holder can recompute.
 *
 * `node:crypto` reads the key (every PEM form, a passphrase) and checks the
 * certificate - that it parses, is in its validity period and matches the key;
 * node-forge only assembles and signs the SignedData, which Node has no API
 * for (AGENTS.md §24: the one consumer of it). Every failure names the secret,
 * never its content.
 */

export interface SignedCms {
  format: "CMS";
  /** The DER-encoded SignedData, base64. */
  signature: string;
  certificate: { subject: string; issuer: string; serialNumber: string; validFrom: string; validTo: string };
}

export interface SignedHmac {
  format: "HMAC_SHA256";
  /** The HMAC-SHA256 of the data, hex (lowercase) or base64. */
  signature: string;
}

/** HMAC-SHA256 of `data` (UTF-8 text) under `key` (the secret's value, as UTF-8 text). */
export function signHmac(data: string, key: string, encoding: "HEX" | "BASE64"): SignedHmac {
  return { format: "HMAC_SHA256", signature: createHmac("sha256", key).update(data, "utf8").digest(encoding === "BASE64" ? "base64" : "hex") };
}

function failed(message: string): TotalBaseError {
  return new TotalBaseError("WORKFLOW_SIGN_FAILED", message);
}

/** Signs `data` (UTF-8 text) as an attached CMS SignedData. `names` are the secrets' keys, for error messages. */
export function signCms(
  data: string,
  certificatePem: string,
  privateKeyPem: string,
  passphrase: string | undefined,
  names: { certificate: string; privateKey: string },
  now: Date = new Date(),
): SignedCms {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    throw failed(`The secret "${names.certificate}" is not a PEM certificate.`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: privateKeyPem, format: "pem", ...(passphrase !== undefined ? { passphrase } : {}) });
  } catch {
    throw failed(`The secret "${names.privateKey}" is not a PEM private key${passphrase === undefined ? " (or it is encrypted and needs a passphrase)" : ", or the passphrase is wrong"}.`);
  }
  if (key.asymmetricKeyType !== "rsa") throw failed(`The secret "${names.privateKey}" is a ${key.asymmetricKeyType ?? "non-RSA"} key; CMS signing takes an RSA key.`);
  if (!certificate.checkPrivateKey(key)) throw failed(`The certificate "${names.certificate}" and the key "${names.privateKey}" are not a pair.`);
  const validFrom = new Date(certificate.validFrom);
  const validTo = new Date(certificate.validTo);
  if (now < validFrom) throw failed(`The certificate "${names.certificate}" is not valid before ${validFrom.toISOString()}.`);
  if (now > validTo) throw failed(`The certificate "${names.certificate}" expired on ${validTo.toISOString()}.`);

  const forgeCertificate = forge.pki.certificateFromPem(certificate.toString());
  const forgeKey = forge.pki.privateKeyFromPem(key.export({ type: "pkcs1", format: "pem" }) as string);
  const signed = forge.pkcs7.createSignedData();
  signed.content = forge.util.createBuffer(data, "utf8");
  signed.addCertificate(forgeCertificate);
  signed.addSigner({
    key: forgeKey,
    certificate: forgeCertificate,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: now as unknown as string },
    ],
  });
  signed.sign();
  const der = forge.asn1.toDer(signed.toAsn1()).getBytes();
  return {
    format: "CMS",
    signature: Buffer.from(der, "binary").toString("base64"),
    certificate: {
      subject: certificate.subject,
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
    },
  };
}

function secretName(configuration: Record<string, unknown>, field: string, what: string): string {
  const value = configuration[field];
  if (typeof value !== "string" || !value.trim()) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `This step's ${what} must name a secret.`);
  return value.trim();
}

const sign: OperationHandler = async ({ context, configuration }) => {
  const format = configuration.format ?? "CMS";
  if (format !== "CMS" && format !== "HMAC_SHA256") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's format must be CMS or HMAC_SHA256.");
  const data = configuration.data;
  if (typeof data !== "string" || data === "") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's data must resolve to a non-empty text.");
  if (format === "HMAC_SHA256") {
    const encoding = configuration.encoding ?? "HEX";
    if (encoding !== "HEX" && encoding !== "BASE64") throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step's encoding must be HEX or BASE64.");
    const key = await context.secrets.decrypt(secretName(configuration, "key", "key"));
    return { output: "next", result: signHmac(data, key, encoding) };
  }
  const names = { certificate: secretName(configuration, "certificate", "certificate"), privateKey: secretName(configuration, "privateKey", "private key") };
  const passphraseName = typeof configuration.passphrase === "string" && configuration.passphrase.trim() ? configuration.passphrase.trim() : undefined;
  const [certificatePem, privateKeyPem, passphrase] = await Promise.all([
    context.secrets.decrypt(names.certificate),
    context.secrets.decrypt(names.privateKey),
    passphraseName ? context.secrets.decrypt(passphraseName) : Promise.resolve(undefined),
  ]);
  return { output: "next", result: signCms(data, certificatePem, privateKeyPem, passphrase, names) };
};

export const SIGN_HANDLERS: Record<string, OperationHandler> = {
  "totalbase.sign": sign,
};
