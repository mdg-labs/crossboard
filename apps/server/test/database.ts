import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAndMigrate, type DatabaseHandle } from "../src/db/index.js";

export interface TestDatabase extends DatabaseHandle {
  dir: string;
  cleanup(): void;
}

export function createTestDatabase(): TestDatabase {
  const dir = mkdtempSync(join(tmpdir(), "crossboard-test-"));
  let handle: DatabaseHandle;
  try {
    handle = openAndMigrate(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    ...handle,
    dir,
    cleanup() {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
