import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";
import { SENTINEL } from "./helpers.js";

function capture() {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

describe("createLogger", () => {
  it("writes one JSON object per line", () => {
    const { lines, destination } = capture();
    createLogger("info", destination).info({ port: 3000 }, "hello");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: 30,
      port: 3000,
      msg: "hello",
    });
  });

  it("honours the configured level", () => {
    const { lines, destination } = capture();
    const logger = createLogger("warn", destination);
    logger.info("dropped");
    logger.debug("dropped");
    logger.warn("kept");
    expect(lines.map((line) => JSON.parse(line).msg)).toEqual(["kept"]);
  });

  it("logs debug when asked to", () => {
    const { lines, destination } = capture();
    createLogger("debug", destination).debug("kept");
    expect(lines).toHaveLength(1);
  });

  it("redacts token, secret, cookie and authorization fields", () => {
    const { lines, destination } = capture();
    createLogger("info", destination).info(
      {
        token: SENTINEL,
        accessToken: SENTINEL,
        refresh_token: SENTINEL,
        clientSecret: SENTINEL,
        webhookSecret: SENTINEL,
        privateKey: SENTINEL,
        cookie: SENTINEL,
        authorization: `Bearer ${SENTINEL}`,
        req: {
          headers: {
            cookie: SENTINEL,
            authorization: `Bearer ${SENTINEL}`,
            "set-cookie": SENTINEL,
          },
        },
        user: { tokens: { access: "kept" }, session: { token: SENTINEL } },
        login: "octocat",
      },
      "request",
    );
    const output = lines.join("");
    expect(output).not.toContain(SENTINEL);
    expect(output).toContain("[Redacted]");
    expect(JSON.parse(output)).toMatchObject({ login: "octocat" });
  });
});
