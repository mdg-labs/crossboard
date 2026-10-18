import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_CREDENTIALS_KEY,
  resolveCredentials,
} from "../src/auth/credentials.js";
import { SETUP_TOKEN_KEY, createSetup } from "../src/auth/setup/index.js";
import { loadConfig } from "../src/config/index.js";
import { schema } from "../src/db/index.js";
import { createLogger } from "../src/logger.js";
import { encrypt } from "../src/security/index.js";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { githubEnv, validEnv } from "./helpers.js";

let database: TestDatabase;
let logs: string[];

beforeEach(() => {
  database = createTestDatabase();
  logs = [];
});

afterEach(() => {
  database.cleanup();
});

const logger = () =>
  createLogger("info", { write: (chunk) => logs.push(chunk) });
const noGithub = () => loadConfig(validEnv);
const withGithub = () => loadConfig({ ...validEnv, ...githubEnv });

const stored = {
  appId: "42",
  appSlug: "stored-app",
  clientId: "Iv1.stored",
  clientSecret: "stored-client-secret",
  privateKey: "stored-private-key",
  webhookSecret: "stored-webhook-secret",
};

function store(value: string, secret = validEnv.CROSSBOARD_APP_SECRET) {
  database.db
    .insert(schema.appConfig)
    .values({
      key: APP_CREDENTIALS_KEY,
      valueEnc: encrypt(value, secret),
      updatedAt: 1,
    })
    .run();
}

const tokenRow = () =>
  database.db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, SETUP_TOKEN_KEY))
    .get();

describe("resolveCredentials", () => {
  it("returns the environment credentials, ignoring stored ones", () => {
    store(JSON.stringify(stored));
    const config = withGithub();
    expect(
      resolveCredentials({ db: database.db, config, logger: logger() }),
    ).toEqual(config.github);
  });

  it("returns the stored credentials when the environment has none", () => {
    store(JSON.stringify(stored));
    expect(
      resolveCredentials({
        db: database.db,
        config: noGithub(),
        logger: logger(),
      }),
    ).toEqual(stored);
  });

  it("returns nothing when neither source has credentials", () => {
    expect(
      resolveCredentials({
        db: database.db,
        config: noGithub(),
        logger: logger(),
      }),
    ).toBeNull();
  });

  it.each([
    [
      "encrypted under another secret",
      () => store(JSON.stringify(stored), "z".repeat(32)),
    ],
    ["not JSON", () => store("not json")],
    ["missing a field", () => store(JSON.stringify({ appId: "1" }))],
  ])(
    "returns nothing, with a warning, when the stored value is %s",
    (_n, seed) => {
      seed();
      expect(
        resolveCredentials({
          db: database.db,
          config: noGithub(),
          logger: logger(),
        }),
      ).toBeNull();
      expect(logs.join("")).toContain('"level":40');
    },
  );
});

describe("setup token", () => {
  it("is generated, logged at warn and stored only as an encrypted hash", () => {
    const setup = createSetup({
      db: database.db,
      config: noGithub(),
      logger: logger(),
    });
    expect(setup.isRequired()).toBe(true);
    const token = setup.start();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const record = JSON.parse(logs.join("").trim()) as {
      level: number;
      setupToken: string;
    };
    expect(record.level).toBe(40);
    expect(record.setupToken).toBe(token);

    const row = tokenRow();
    expect(row?.valueEnc.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(token ?? "");
    expect(setup.verify(token ?? "")).toBe(true);
    expect(setup.verify("wrong")).toBe(false);
    expect(setup.verify("")).toBe(false);
  });

  it("is replaced by a new one at the next start", () => {
    const options = {
      db: database.db,
      config: noGithub(),
      logger: logger(),
    };
    const first = createSetup(options).start() ?? "";
    const restarted = createSetup(options);
    const second = restarted.start() ?? "";
    expect(second).not.toBe(first);
    expect(restarted.verify(first)).toBe(false);
    expect(restarted.verify(second)).toBe(true);
    expect(
      database.sqlite.prepare("SELECT count(*) FROM app_config").pluck().get(),
    ).toBe(1);
  });

  it("is not generated or logged when the environment has credentials", () => {
    const setup = createSetup({
      db: database.db,
      config: withGithub(),
      logger: logger(),
    });
    expect(setup.isRequired()).toBe(false);
    expect(setup.start()).toBeNull();
    expect(tokenRow()).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("is not generated when stored credentials exist", () => {
    store(JSON.stringify(stored));
    const setup = createSetup({
      db: database.db,
      config: noGithub(),
      logger: logger(),
    });
    expect(setup.start()).toBeNull();
    expect(tokenRow()).toBeUndefined();
  });

  it("stops being required once credentials are stored", () => {
    const setup = createSetup({
      db: database.db,
      config: noGithub(),
      logger: logger(),
    });
    const token = setup.start() ?? "";
    expect(setup.isRequired()).toBe(true);
    store(JSON.stringify(stored));
    expect(setup.isRequired()).toBe(false);
    expect(token).not.toBe("");
  });

  it("does not verify a hash stored under another secret", () => {
    const token =
      createSetup({
        db: database.db,
        config: noGithub(),
        logger: logger(),
      }).start() ?? "";
    const other = loadConfig({
      ...validEnv,
      CROSSBOARD_APP_SECRET: "q".repeat(32),
    });
    expect(
      createSetup({ db: database.db, config: other, logger: logger() }).verify(
        token,
      ),
    ).toBe(false);
  });
});
