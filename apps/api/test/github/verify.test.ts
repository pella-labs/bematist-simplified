import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "../../src/github/verify";

function sign(body: string | Uint8Array, secret: string): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return `sha256=${createHmac("sha256", secret).update(buf).digest("hex")}`;
}

describe("verifyGithubSignature", () => {
  const secret = "test-secret-a";
  const body = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

  it("accepts a correctly signed body", () => {
    const sig = sign(body, secret);
    const res = verifyGithubSignature({
      rawBody: body,
      signatureHeader: sig,
      activeSecret: secret,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.path).toBe("active");
  });

  it("rejects with missing_signature when header is null", () => {
    const res = verifyGithubSignature({
      rawBody: body,
      signatureHeader: null,
      activeSecret: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_signature");
  });

  it("rejects with malformed_signature when prefix is wrong", () => {
    const res = verifyGithubSignature({
      rawBody: body,
      signatureHeader: "sha1=deadbeef",
      activeSecret: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("malformed_signature");
  });

  it("rejects with active_mismatch on a wrong signature", () => {
    const sig = sign(body, "other-secret");
    const res = verifyGithubSignature({
      rawBody: body,
      signatureHeader: sig,
      activeSecret: secret,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("active_mismatch");
  });

  it("rejects tampered body with active_mismatch", () => {
    const sig = sign(body, secret);
    const tampered = new TextEncoder().encode(JSON.stringify({ hello: "xxx" }));
    const res = verifyGithubSignature({
      rawBody: tampered,
      signatureHeader: sig,
      activeSecret: secret,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-hex signature without throwing", () => {
    const res = verifyGithubSignature({
      rawBody: body,
      signatureHeader: `sha256=${"zz".repeat(32)}`,
      activeSecret: secret,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects signature of wrong hex length", () => {
    const res = verifyGithubSignature({
      rawBody: body,
      signatureHeader: "sha256=deadbeef",
      activeSecret: secret,
    });
    expect(res.ok).toBe(false);
  });
});
