import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../src/db/index.js";
import {
  readJournal,
  runMigrationCase,
  type MigrationCase,
} from "./migration-harness.js";

const NOW = 1_760_000_000_000;

// Seeded at migration 0000_initial, in foreign-key order. A later schema
// change adds a case seeded at the migration before it.
const initial: MigrationCase = {
  name: "0000_initial to latest",
  fromTag: "0000_initial",
  preservedTables: {
    boards: { orderBy: "id" },
    board_columns: { orderBy: "id" },
    saved_views: { orderBy: "id" },
  },
  rows: {
    app_config: [
      { key: "setup_token_hash", value_enc: "v1:a:b:c", updated_at: NOW },
    ],
    users: [
      {
        id: 1,
        github_id: 101,
        login: "octocat",
        name: "Octo",
        avatar_url: "https://a/1",
        created_at: NOW,
        last_login_at: NOW,
      },
      {
        id: 2,
        github_id: 102,
        login: "hubot",
        name: null,
        avatar_url: "https://a/2",
        created_at: NOW,
        last_login_at: NOW,
      },
    ],
    user_tokens: [
      {
        user_id: 1,
        access_token_enc: "v1:a",
        access_expires_at: NOW,
        refresh_token_enc: "v1:r",
        refresh_expires_at: NOW,
        updated_at: NOW,
      },
    ],
    sessions: [
      {
        token_hash: "hash-1",
        user_id: 1,
        created_at: NOW,
        last_seen_at: NOW,
        expires_at: NOW + 1000,
      },
    ],
    installations: [
      {
        id: 900,
        account_login: "octocat",
        account_id: 101,
        account_type: "User",
        suspended: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    user_installations: [
      { user_id: 1, installation_id: 900, computed_at: NOW },
    ],
    repos: [
      {
        id: "R_1",
        database_id: 5000,
        installation_id: 900,
        owner: "octocat",
        name: "hello",
        private: 0,
        sync_state: "ready",
        sync_detail: null,
        open_issue_count: 1,
        last_full_sync_at: NOW,
        last_reconciled_at: null,
        reconcile_since: "2026-10-01T00:00:00Z",
        rest_etag: null,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    user_repo_access: [{ user_id: 1, repo_id: "R_1", computed_at: NOW }],
    issues: [
      {
        id: "I_1",
        database_id: 7000,
        repo_id: "R_1",
        number: 1,
        title: "Bug",
        url: "https://github.com/octocat/hello/issues/1",
        author_login: "hubot",
        type_name: null,
        type_color: null,
        milestone_title: null,
        milestone_url: null,
        parent_id: null,
        sub_total: 0,
        sub_completed: 0,
        blocked_by_total: 1,
        blocking_total: 0,
        created_at: NOW,
        updated_at: NOW,
        synced_at: NOW,
      },
    ],
    labels: [
      {
        id: "L_1",
        repo_id: "R_1",
        name: "bug",
        color: "d73a4a",
        description: null,
      },
    ],
    issue_labels: [{ issue_id: "I_1", label_id: "L_1" }],
    issue_assignees: [
      { issue_id: "I_1", login: "hubot", avatar_url: "https://a/2" },
    ],
    issue_refs: [
      {
        id: "I_1",
        repo_full_name: "octocat/hello",
        number: 1,
        title: "Bug",
        state: "OPEN",
        url: "https://github.com/octocat/hello/issues/1",
        seen_at: NOW,
      },
      {
        id: "I_X",
        repo_full_name: "other/repo",
        number: 9,
        title: "Upstream",
        state: "OPEN",
        url: "https://github.com/other/repo/issues/9",
        seen_at: NOW,
      },
    ],
    issue_deps: [{ blocked_id: "I_1", blocking_id: "I_X" }],
    issue_details: [
      {
        issue_id: "I_1",
        body_html: "<p>x</p>",
        comments_json: "[]",
        comments_total: 0,
        sub_issues_json: "[]",
        fetched_for_updated_at: NOW,
        fetched_at: NOW,
      },
    ],
    boards: [
      {
        id: 1,
        user_id: 1,
        name: "Sprint",
        base_filter: "is:open",
        sort: "updated-desc",
        sub_issue_mode: "nested",
        show_other: 1,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: 2,
        user_id: 2,
        name: "Triage",
        base_filter: "label:bug",
        sort: "created-asc",
        sub_issue_mode: "flat",
        show_other: 0,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    board_columns: [
      { id: 1, board_id: 1, position: 0, name: "Todo", filter: "no:assignee" },
      {
        id: 2,
        board_id: 1,
        position: 1,
        name: "Doing",
        filter: "assignee:@me",
      },
      { id: 3, board_id: 2, position: 0, name: "Bugs", filter: "label:bug" },
    ],
    saved_views: [
      {
        id: 1,
        user_id: 1,
        name: "Mine",
        filter: "assignee:@me",
        sort: "updated-desc",
        created_at: NOW,
        updated_at: NOW,
      },
      {
        id: 2,
        user_id: 2,
        name: "Mine",
        filter: "author:@me",
        sort: "created-asc",
        created_at: NOW,
        updated_at: NOW,
      },
    ],
  },
};

const cases = [initial];

describe("migration harness", () => {
  it.each(cases)(
    "$name keeps every board, column and saved view",
    (testCase) => {
      runMigrationCase(testCase);
    },
  );

  it("has a case seeded at the migration before every migration", () => {
    const tags = readJournal().entries.map((entry) => entry.tag);
    const required = tags.map((_, index) => tags[Math.max(index - 1, 0)]);
    for (const tag of new Set(required)) {
      expect(
        cases.map((testCase) => testCase.fromTag),
        `no migration case is seeded at ${String(tag)}`,
      ).toContain(tag);
    }
  });

  describe("detects a migration that loses user data", () => {
    function withLaterMigration(sql: string) {
      const dir = mkdtempSync(join(tmpdir(), "crossboard-fixture-"));
      mkdirSync(join(dir, "meta"), { recursive: true });
      const journal = readJournal();
      const first = journal.entries[0];
      if (first === undefined) throw new Error("no migrations");
      cpSync(
        join(MIGRATIONS_FOLDER, `${first.tag}.sql`),
        join(dir, `${first.tag}.sql`),
      );
      writeFileSync(join(dir, "0001_lossy.sql"), sql);
      writeFileSync(
        join(dir, "meta", "_journal.json"),
        JSON.stringify({
          ...journal,
          entries: [
            first,
            {
              idx: 1,
              version: "6",
              when: 9_999_999_999_999,
              tag: "0001_lossy",
              breakpoints: true,
            },
          ],
        }),
      );
      return dir;
    }

    it("when it deletes rows", () => {
      const dir = withLaterMigration("DELETE FROM `saved_views`;");
      try {
        expect(() => runMigrationCase(initial, dir)).toThrow(/after migrating/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("when a table rebuild cascades through foreign keys", () => {
      const dir = withLaterMigration(
        "CREATE TABLE `users_new` (`id` integer PRIMARY KEY NOT NULL);\n--> statement-breakpoint\nINSERT INTO `users_new` SELECT `id` FROM `users`;\n--> statement-breakpoint\nDROP TABLE `users`;\n--> statement-breakpoint\nALTER TABLE `users_new` RENAME TO `users`;",
      );
      try {
        expect(() => runMigrationCase(initial, dir)).toThrow(/after migrating/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
