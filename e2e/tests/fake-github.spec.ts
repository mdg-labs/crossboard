import { createSign } from "node:crypto";
import { expect, test } from "@playwright/test";
import { startFakeGithub, type FakeGithub } from "../fake-github/server.js";
import { APP_ID, CLIENT_ID, newAppKeys } from "../support/container.js";

const keys = newAppKeys();
const otherKeys = newAppKeys();

const segment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function appJwt(
  claims: { iss?: string; iat?: number; exp?: number } = {},
  { alg = "RS256", privateKey = keys.privateKey } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const data = `${segment({ alg, typ: "JWT" })}.${segment({
    iss: APP_ID,
    iat: now - 60,
    exp: now + 9 * 60,
    ...claims,
  })}`;
  const signature = createSign("RSA-SHA256").update(data).sign(privateKey);
  return `${data}.${signature.toString("base64url")}`;
}

let fake: FakeGithub;

test.beforeAll(async () => {
  fake = await startFakeGithub({
    clientId: CLIENT_ID,
    clientSecret: "secret",
    appId: APP_ID,
    appPublicKey: keys.publicKey,
  });
});

test.afterAll(async () => {
  await fake.close();
});

const mintToken = (authorization: string) =>
  fetch(`${fake.url}/app/installations/1001/access_tokens`, {
    method: "POST",
    headers: { authorization },
  });

const graphql = (authorization: string, operationName = "NoSuchOperation") =>
  fetch(`${fake.url}/graphql`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ query: `query ${operationName} { viewer { id } }` }),
  });

test("the fake issues an installation token for a correctly signed App JWT", async () => {
  const response = await mintToken(`Bearer ${appJwt()}`);

  expect(response.status).toBe(201);
  const body = (await response.json()) as { token: string };
  expect(body.token).toBe("ghs_e2e_1001");
});

test.describe("the fake refuses an App JWT that GitHub would refuse", () => {
  const now = () => Math.floor(Date.now() / 1000);
  const cases: Record<string, () => string> = {
    "three segments that are not a JWT": () => "a.b.c",
    "signed with another key": () =>
      appJwt({}, { privateKey: otherKeys.privateKey }),
    "a non-RS256 algorithm": () => appJwt({}, { alg: "none" }),
    "another App as issuer": () => appJwt({ iss: "99999" }),
    expired: () => appJwt({ iat: now() - 700, exp: now() - 100 }),
    "valid for more than ten minutes": () => appJwt({ exp: now() + 11 * 60 }),
    "issued in the future": () => appJwt({ iat: now() + 120 }),
  };
  for (const [name, token] of Object.entries(cases)) {
    test(name, async () => {
      const response = await mintToken(`Bearer ${token()}`);

      expect(response.status).toBe(401);
    });
  }

  test("an installation or user token in place of a JWT", async () => {
    expect((await mintToken("Bearer ghs_e2e_1001")).status).toBe(401);
  });
});

test.describe("the fake GraphQL endpoint accepts only tokens it issued", () => {
  for (const authorization of [
    "Bearer undefined",
    "Bearer not-a-token",
    "Bearer ghs_e2e_424242",
    "Bearer ghu_e2e_nobody",
    `Bearer ${appJwt()}`,
    "Basic abc",
  ]) {
    test(`rejects ${authorization.split(".")[0] ?? ""}`, async () => {
      const response = await graphql(authorization);

      expect(response.status).toBe(401);
    });
  }

  for (const token of ["ghs_e2e_1001", "ghu_e2e_octocat"]) {
    test(`reaches the fixtures with ${token}`, async () => {
      const response = await graphql(`Bearer ${token}`);

      // Authenticated: the missing fixture, not the credentials, is refused.
      expect(response.status).toBe(404);
    });
  }
});
