import { randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

const fixtureUrl = (name: string) =>
  new URL(`./fixtures/${name}`, import.meta.url);

const readFixture = <T>(name: string): T =>
  JSON.parse(readFileSync(fixtureUrl(name), "utf8")) as T;

interface FixtureUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  installations: number[];
}

interface FixtureInstallation {
  id: number;
}

type FixtureRepositories = Record<string, unknown[]>;

export interface FakeGithubOptions {
  clientId: string;
  clientSecret: string;
  /** The App id an App JWT must carry as `iss`. */
  appId: string;
  /** PEM public half of the key the App JWTs must be signed with (RS256). */
  appPublicKey: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  handled: boolean;
}

export interface FakeGithub {
  /** Base URL to use for both `CROSSBOARD_GITHUB_API_URL` and `CROSSBOARD_GITHUB_WEB_URL`. */
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  /** The user the next `/login/oauth/authorize` request signs in as. */
  signInAs(login: string): void;
  close(): Promise<void>;
}

const USER_TOKEN_PREFIX = "ghu_e2e_";
const REFRESH_TOKEN_PREFIX = "ghr_e2e_";
const INSTALLATION_TOKEN_PREFIX = "ghs_e2e_";
interface AnswerByVariables {
  answerBy: string[];
  answers: Record<string, unknown>;
}

interface NodesByIds {
  nodesBy: string;
  rateLimit?: unknown;
  nodes: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The body a fixture answers with for these variables (see `fixtures/graphql/README.md`). */
function fixtureBody(
  name: string,
  fixture: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (isObject(fixture) && "answerBy" in fixture) {
    const { answerBy, answers } = fixture as unknown as AnswerByVariables;
    const key = answerBy
      .map((variable) => String(variables[variable]))
      .join("/");
    if (!Object.hasOwn(answers, key)) {
      throw new HttpError(404, `No GraphQL fixture for ${name} with ${key}`);
    }
    return answers[key];
  }
  if (isObject(fixture) && "nodesBy" in fixture) {
    const { nodesBy, rateLimit, nodes } = fixture as unknown as NodesByIds;
    const ids = variables[nodesBy];
    if (!Array.isArray(ids)) {
      throw new HttpError(400, `${name} needs the ${nodesBy} variable`);
    }
    return {
      data: {
        ...(rateLimit === undefined ? {} : { rateLimit }),
        nodes: ids.map((id) =>
          typeof id === "string" && Object.hasOwn(nodes, id) ? nodes[id] : null,
        ),
      },
    };
  }
  return fixture;
}

const OPERATION_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const OPERATION_IN_QUERY = /\bquery\s+([_A-Za-z]\w*)/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readParams(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw === "") return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // reported below as one error for every malformed body
  }
  throw new HttpError(400, "Problems parsing JSON");
}

const MAX_JWT_LIFETIME_SECONDS = 10 * 60;

const decodeSegment = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

/** What GitHub checks on an App JWT: RS256 signature, `iss`, and the `iat`/`exp` window. */
function isValidAppJwt(
  token: string | null,
  appId: string,
  publicKey: string,
): boolean {
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts as [string, string, string];
  const head = decodeSegment(header) as { alg?: unknown } | null;
  const claims = decodeSegment(payload) as {
    iss?: unknown;
    iat?: unknown;
    exp?: unknown;
  } | null;
  if (head?.alg !== "RS256" || claims === null) return false;
  let signed: boolean;
  try {
    signed = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
  if (!signed) return false;
  const { iss, iat, exp } = claims;
  if (typeof iss !== "string" && typeof iss !== "number") return false;
  if (String(iss) !== appId) return false;
  if (typeof iat !== "number" || typeof exp !== "number") return false;
  const now = Date.now() / 1000;
  return iat <= now && exp > now && exp - now <= MAX_JWT_LIFETIME_SECONDS;
}

const bearer = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
};

/**
 * A small GitHub: the OAuth web flow, the REST endpoints Crossboard reads and
 * a GraphQL endpoint, all answered from `fixtures/`. Later items add GraphQL
 * fixtures (`fixtures/graphql/<OperationName>.json`) without touching this
 * file. It has no mutation: every GraphQL mutation is refused.
 */
export async function startFakeGithub(
  options: FakeGithubOptions,
): Promise<FakeGithub> {
  const users = readFixture<FixtureUser[]>("users.json");
  const installations =
    readFixture<(FixtureInstallation & Record<string, unknown>)[]>(
      "installations.json",
    );
  const repositories = readFixture<FixtureRepositories>("repositories.json");

  const requests: RecordedRequest[] = [];
  const codes = new Map<string, string>();
  let nextLogin: string | null = null;
  let origin = "";

  const userByLogin = (login: string) =>
    users.find((user) => user.login === login);

  function userFromToken(req: IncomingMessage, prefix: string): FixtureUser {
    const token = bearer(req);
    const login = token?.startsWith(prefix) ? token.slice(prefix.length) : "";
    const user = userByLogin(login);
    if (user === undefined) throw new HttpError(401, "Bad credentials");
    return user;
  }

  /** GraphQL takes a token this fake issued: an installation token or a user token. */
  function assertIssuedToken(req: IncomingMessage): void {
    const token = bearer(req) ?? "";
    const known = token.startsWith(INSTALLATION_TOKEN_PREFIX)
      ? installations.some(
          (installation) =>
            token === `${INSTALLATION_TOKEN_PREFIX}${String(installation.id)}`,
        )
      : token.startsWith(USER_TOKEN_PREFIX) &&
        userByLogin(token.slice(USER_TOKEN_PREFIX.length)) !== undefined;
    if (!known) throw new HttpError(401, "Bad credentials");
  }

  const installationsOf = (user: FixtureUser) =>
    installations.filter((installation) =>
      user.installations.includes(installation.id),
    );

  function issueTokens(login: string) {
    return {
      access_token: `${USER_TOKEN_PREFIX}${login}`,
      expires_in: 28800,
      refresh_token: `${REFRESH_TOKEN_PREFIX}${login}`,
      refresh_token_expires_in: 15811200,
      token_type: "bearer",
      scope: "",
    };
  }

  function authorize(url: URL, res: ServerResponse): void {
    if (url.searchParams.get("client_id") !== options.clientId) {
      throw new HttpError(404, "Not Found");
    }
    const redirectUri = url.searchParams.get("redirect_uri");
    if (redirectUri === null) throw new HttpError(400, "redirect_uri missing");
    if (nextLogin === null) {
      throw new HttpError(400, "No user selected: call signInAs() first");
    }
    const code = `code_${randomBytes(12).toString("hex")}`;
    codes.set(code, nextLogin);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state !== null) target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() });
    res.end();
  }

  async function accessToken(req: IncomingMessage, res: ServerResponse) {
    const params = await readParams(req);
    const failure = (error: string, description: string) =>
      send(res, 200, { error, error_description: description });
    if (
      params.client_id !== options.clientId ||
      params.client_secret !== options.clientSecret
    ) {
      return failure(
        "incorrect_client_credentials",
        "The client_id and/or client_secret passed are incorrect.",
      );
    }
    if (params.grant_type === "refresh_token") {
      const token = String(params.refresh_token ?? "");
      const login = token.startsWith(REFRESH_TOKEN_PREFIX)
        ? token.slice(REFRESH_TOKEN_PREFIX.length)
        : "";
      return userByLogin(login) === undefined
        ? failure("bad_refresh_token", "The refresh token passed is incorrect.")
        : send(res, 200, issueTokens(login));
    }
    const login = codes.get(String(params.code ?? ""));
    if (login === undefined) {
      return failure(
        "bad_verification_code",
        "The code passed is incorrect or expired.",
      );
    }
    codes.delete(String(params.code));
    return send(res, 200, issueTokens(login));
  }

  async function graphql(req: IncomingMessage, res: ServerResponse) {
    const params = await readParams(req);
    const query = typeof params.query === "string" ? params.query : "";
    const match = OPERATION_IN_QUERY.exec(query);
    const name =
      typeof params.operationName === "string"
        ? params.operationName
        : match?.[1];
    if (/\b(mutation|subscription)\b/.test(query)) {
      throw new HttpError(400, "The fake GitHub answers GraphQL queries only");
    }
    if (name === undefined || !OPERATION_NAME.test(name)) {
      throw new HttpError(400, "Anonymous GraphQL operations are not served");
    }
    let fixture: unknown;
    try {
      fixture = readFixture<unknown>(`graphql/${name}.json`);
    } catch {
      throw new HttpError(404, `No GraphQL fixture for operation ${name}`);
    }
    const variables = isObject(params.variables) ? params.variables : {};
    send(res, 200, fixtureBody(name, fixture, variables));
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    record: RecordedRequest,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", origin);
    const method = req.method ?? "GET";
    record.path = url.pathname;
    const is = (expected: string, path: string) =>
      method === expected && url.pathname === path;
    const match = (expected: string, pattern: RegExp) =>
      method === expected ? pattern.exec(url.pathname) : null;

    if (is("GET", "/login/oauth/authorize")) return authorize(url, res);
    if (is("POST", "/login/oauth/access_token")) return accessToken(req, res);
    if (is("POST", "/graphql")) {
      assertIssuedToken(req);
      return graphql(req, res);
    }
    if (is("GET", "/user")) {
      const user = userFromToken(req, USER_TOKEN_PREFIX);
      return send(res, 200, {
        id: user.id,
        login: user.login,
        name: user.name,
        avatar_url: user.avatar_url,
      });
    }
    if (is("GET", "/user/installations")) {
      const owned = installationsOf(userFromToken(req, USER_TOKEN_PREFIX));
      return send(res, 200, {
        total_count: owned.length,
        installations: owned,
      });
    }
    const userRepositories = match(
      "GET",
      /^\/user\/installations\/(\d+)\/repositories$/,
    );
    if (userRepositories !== null) {
      const id = Number(userRepositories[1]);
      const user = userFromToken(req, USER_TOKEN_PREFIX);
      if (!user.installations.includes(id)) {
        throw new HttpError(404, "Not Found");
      }
      const list = repositories[String(id)] ?? [];
      return send(res, 200, { total_count: list.length, repositories: list });
    }
    const tokenFor = match(
      "POST",
      /^\/app\/installations\/(\d+)\/access_tokens$/,
    );
    if (tokenFor !== null) {
      if (!isValidAppJwt(bearer(req), options.appId, options.appPublicKey)) {
        throw new HttpError(401, "A JSON web token could not be decoded");
      }
      const id = Number(tokenFor[1]);
      if (!installations.some((installation) => installation.id === id)) {
        throw new HttpError(404, "Not Found");
      }
      return send(res, 201, {
        token: `${INSTALLATION_TOKEN_PREFIX}${String(id)}`,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    if (is("GET", "/installation/repositories")) {
      const token = bearer(req) ?? "";
      const id = token.startsWith(INSTALLATION_TOKEN_PREFIX)
        ? token.slice(INSTALLATION_TOKEN_PREFIX.length)
        : "";
      const list = repositories[id];
      if (list === undefined) throw new HttpError(401, "Bad credentials");
      return send(res, 200, { total_count: list.length, repositories: list });
    }
    throw new HttpError(404, "Not Found");
  }

  const server: Server = createServer((req, res) => {
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: req.url ?? "/",
      handled: false,
    };
    requests.push(record);
    route(req, res, record).then(
      () => {
        record.handled = res.statusCode < 400;
      },
      (error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        const message =
          error instanceof Error ? error.message : "Internal Server Error";
        send(res, status, { message });
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    url: origin,
    requests,
    signInAs(login) {
      if (userByLogin(login) === undefined) {
        throw new Error(`No fixture user ${login}`);
      }
      nextLogin = login;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
