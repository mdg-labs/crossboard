import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { promisify } from "node:util";

const docker = promisify(execFile);

export const CLIENT_ID = "Iv1.e2eclient";
export const ALLOWED_USER = "octocat";
export const ALLOWED_ORG = "acme";

export interface Container {
  /** Where browsers reach Crossboard (`CROSSBOARD_PUBLIC_URL`). */
  readonly url: string;
  /** The App's OAuth client secret, shared with the fake GitHub. */
  readonly clientSecret: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("could not reserve a port");
  }
  return address.port;
}

export const newClientSecret = () => randomBytes(20).toString("hex");

export const APP_ID = "12345";

/** A fresh App key pair: the container gets the private half, the fake GitHub the public half. */
export function newAppKeys(): { privateKey: string; publicKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

export interface StartContainerOptions {
  image: string;
  githubUrl: string;
  clientSecret: string;
  appPrivateKey: string;
}

/**
 * Runs the built image with App credentials from env vars (SPEC FR-50) and
 * both GitHub base URLs pointing at the fake. The container shares the host's
 * network so it reaches the fake on the loopback address and the browser
 * reaches both on the same names. Secrets are generated per run and passed by
 * name, so they never appear in a process listing.
 */
export async function startContainer({
  image,
  githubUrl,
  clientSecret,
  appPrivateKey,
}: StartContainerOptions): Promise<Container> {
  const port = await freePort();
  const url = `http://localhost:${String(port)}`;
  const name = `crossboard-e2e-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  const secrets = {
    CROSSBOARD_APP_SECRET: randomBytes(32).toString("hex"),
    GITHUB_CLIENT_SECRET: clientSecret,
    GITHUB_PRIVATE_KEY: appPrivateKey,
    GITHUB_WEBHOOK_SECRET: randomBytes(20).toString("hex"),
  };
  const plain = {
    CROSSBOARD_PUBLIC_URL: url,
    CROSSBOARD_ALLOWED_USERS: ALLOWED_USER,
    CROSSBOARD_ALLOWED_ORGS: ALLOWED_ORG,
    PORT: String(port),
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_SLUG: "crossboard-e2e",
    GITHUB_CLIENT_ID: CLIENT_ID,
    CROSSBOARD_GITHUB_API_URL: githubUrl,
    CROSSBOARD_GITHUB_WEB_URL: githubUrl,
  };

  const stop = async () => {
    await docker("docker", ["rm", "--force", "--volumes", name]).catch(
      () => undefined,
    );
  };

  // No `--rm`: a container that exits at startup must stay so its logs can be
  // read; `stop()` is the only cleanup and every path below ends in it.
  try {
    await docker(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        "host",
        ...Object.entries(plain).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        ...Object.keys(secrets).flatMap((key) => ["--env", key]),
        image,
      ],
      { env: { ...process.env, ...secrets } },
    );
  } catch (error) {
    await stop();
    throw error;
  }

  const deadline = Date.now() + 60_000;
  for (;;) {
    const healthy = await fetch(`${url}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) break;
    if (Date.now() > deadline) {
      const logs = await docker("docker", ["logs", name]).then(
        ({ stdout, stderr }) => stdout + stderr,
        () => "(no container logs)",
      );
      await stop();
      throw new Error(`${image} did not become healthy in time:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { url, clientSecret, stop };
}
