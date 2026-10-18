import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  decrypt,
  encrypt,
  requireSameOriginJson,
} from "../src/security/index.js";

const SECRET = "s".repeat(32);

describe("encryption at rest", () => {
  it("round-trips a value as v1:<iv>:<ciphertext>:<tag> in base64url", () => {
    const stored = encrypt("ghu_example value ✓", SECRET);
    const parts = stored.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(Buffer.from(parts[1] ?? "", "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[3] ?? "", "base64url")).toHaveLength(16);
    expect(stored).not.toContain("ghu_example");
    expect(decrypt(stored, SECRET)).toBe("ghu_example value ✓");
  });

  it("uses a fresh random IV for every value", () => {
    const first = encrypt("same", SECRET);
    const second = encrypt("same", SECRET);
    expect(first.split(":")[1]).not.toBe(second.split(":")[1]);
    expect(first).not.toBe(second);
  });

  it("fails to decrypt with a different secret", () => {
    expect(() => decrypt(encrypt("x", SECRET), "t".repeat(32))).toThrow();
  });

  it.each([1, 2, 3])(
    "fails to decrypt when part %i is tampered with",
    (index) => {
      const parts = encrypt("a longer plaintext value", SECRET).split(":");
      const original = parts[index] ?? "";
      const flipped = Buffer.from(original, "base64url");
      flipped[0] = (flipped[0] ?? 0) ^ 1;
      parts[index] = flipped.toString("base64url");
      expect(() => decrypt(parts.join(":"), SECRET)).toThrow();
    },
  );

  it.each(["", "plain", "v2:a:b:c", "v1:a:b", "v1:a:b:c:d"])(
    "rejects the malformed value %j",
    (value) => {
      expect(() => decrypt(value, SECRET)).toThrow();
    },
  );
});

describe("requireSameOriginJson", () => {
  const app = new Hono().post(
    "/change",
    requireSameOriginJson("https://crossboard.example.com/base"),
    (c) => c.json({ ok: true }),
  );

  const send = (headers: Record<string, string>, body = "{}") =>
    app.request("/change", { method: "POST", headers, body });

  it("passes a same-origin JSON request, with or without a charset", async () => {
    for (const contentType of [
      "application/json",
      "Application/JSON; charset=utf-8",
    ]) {
      const response = await send({
        Origin: "https://crossboard.example.com",
        "Content-Type": contentType,
      });
      expect(response.status, contentType).toBe(200);
    }
  });

  it.each([
    ["missing", undefined],
    ["foreign", "https://evil.example.com"],
    ["a different scheme", "http://crossboard.example.com"],
    ["a different port", "https://crossboard.example.com:8443"],
    ["a suffix lookalike", "https://crossboard.example.com.evil.test"],
    ["null", "null"],
  ])("rejects a %s Origin with 403", async (_name, origin) => {
    const response = await send({
      ...(origin === undefined ? {} : { Origin: origin }),
      "Content-Type": "application/json",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "forbidden" },
    });
  });

  it.each([
    ["form-encoded", "application/x-www-form-urlencoded"],
    ["plain text", "text/plain"],
    ["multipart", "multipart/form-data; boundary=x"],
    ["absent", undefined],
  ])("rejects a %s body with 415", async (_name, contentType) => {
    const response = await send({
      Origin: "https://crossboard.example.com",
      ...(contentType === undefined ? {} : { "Content-Type": contentType }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_media_type" },
    });
  });
});
