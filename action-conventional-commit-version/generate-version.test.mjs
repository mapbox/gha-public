/**
 * Tests for generate-version.mjs's exported pure helpers. Importing this file never runs
 * main() -- see the guard at the bottom of generate-version.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  getCommitMessagesInRange,
  getCurrentVersion,
  getIncrementTypeForMessage,
  getIncrementTypeFromMessages,
  getRangeStart,
  increment,
  releaseCore,
  SEMVER_RE,
} from "./generate-version.mjs";

test("SEMVER_RE", async (t) => {
  await t.test("matches a clean version", () => {
    assert.equal(SEMVER_RE.test("1.2.3"), true);
  });

  await t.test("matches a prerelease version", () => {
    assert.equal(SEMVER_RE.test("1.2.3-abc1234"), true);
    assert.equal(SEMVER_RE.test("1.2.3-alpha.1"), true);
  });

  await t.test("rejects non-semver output", () => {
    assert.equal(SEMVER_RE.test("not a version"), false);
    assert.equal(SEMVER_RE.test(""), false);
    assert.equal(SEMVER_RE.test("1.2"), false);
  });
});

test("releaseCore", async (t) => {
  await t.test("strips a prerelease suffix", () => {
    assert.deepEqual(releaseCore("1.2.3-abc1234"), [1, 2, 3]);
  });

  await t.test("passes through a clean version", () => {
    assert.deepEqual(releaseCore("1.2.3"), [1, 2, 3]);
  });
});

test("compareVersions", async (t) => {
  await t.test("is 0 for equal versions", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });

  await t.test("ignores prerelease suffixes", () => {
    assert.equal(compareVersions("1.2.3-abc", "1.2.3-def"), 0);
  });

  await t.test("is positive when the first is higher", () => {
    assert.ok(compareVersions("2.0.0", "1.9.9") > 0);
    assert.ok(compareVersions("1.10.0", "1.9.0") > 0); // numeric, not lexicographic
  });

  await t.test("is negative when the first is lower", () => {
    assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
  });
});

test("increment", async (t) => {
  await t.test("patch", () => {
    assert.equal(increment("1.2.3", "patch"), "1.2.4");
  });

  await t.test("minor resets patch", () => {
    assert.equal(increment("1.2.3", "minor"), "1.3.0");
  });

  await t.test("major resets minor and patch", () => {
    assert.equal(increment("1.2.3", "major"), "2.0.0");
  });
});

test("getIncrementTypeForMessage", async (t) => {
  await t.test("feat -> minor", () => {
    assert.equal(getIncrementTypeForMessage("feat: add dropdowns"), "minor");
  });

  await t.test("fix -> patch", () => {
    assert.equal(getIncrementTypeForMessage("fix: resolved issue with dropdowns"), "patch");
  });

  await t.test("perf -> patch", () => {
    assert.equal(getIncrementTypeForMessage("perf: speed up dropdown rendering"), "patch");
  });

  await t.test("revert -> patch", () => {
    assert.equal(getIncrementTypeForMessage("revert: feat: add dropdowns"), "patch");
  });

  await t.test("chore/docs/style/refactor/test/build/ci -> no release", () => {
    for (const type of ["chore", "docs", "style", "refactor", "test", "build", "ci"]) {
      assert.equal(getIncrementTypeForMessage(`${type}: did a thing`), null, type);
    }
  });

  await t.test("scope is accepted and ignored", () => {
    assert.equal(getIncrementTypeForMessage("feat(dropdowns): add multi-select"), "minor");
  });

  await t.test("bang after type -> major, regardless of type", () => {
    assert.equal(getIncrementTypeForMessage("feat!: overhauled dropdowns"), "major");
    assert.equal(getIncrementTypeForMessage("fix!: overhauled dropdowns"), "major");
    assert.equal(getIncrementTypeForMessage("chore!: overhauled dropdowns"), "major");
  });

  await t.test("bang after scope -> major", () => {
    assert.equal(getIncrementTypeForMessage("feat(dropdowns)!: overhauled dropdowns"), "major");
  });

  await t.test("BREAKING CHANGE footer -> major, even without a bang", () => {
    const message = [
      "fix: resolved issue with dropdowns",
      "",
      "BREAKING CHANGE: dropdowns must now be imported from a different path",
    ].join("\n");
    assert.equal(getIncrementTypeForMessage(message), "major");
  });

  await t.test("BREAKING-CHANGE footer (hyphenated) -> major", () => {
    const message = ["fix: resolved issue", "", "BREAKING-CHANGE: see above"].join("\n");
    assert.equal(getIncrementTypeForMessage(message), "major");
  });

  await t.test("non-conventional message -> no release", () => {
    assert.equal(getIncrementTypeForMessage("wip fixed some stuff"), null);
    assert.equal(getIncrementTypeForMessage(""), null);
  });
});

test("getIncrementTypeFromMessages", async (t) => {
  await t.test("highest across multiple commits wins", () => {
    const messages = ["chore: tidy up", "fix: off-by-one", "feat: add dropdowns"];
    assert.equal(getIncrementTypeFromMessages(messages), "minor");
  });

  await t.test("a single fix among non-releasing commits is still a patch", () => {
    const messages = ["chore: tidy up", "fix: off-by-one", "docs: update readme"];
    assert.equal(getIncrementTypeFromMessages(messages), "patch");
  });

  await t.test("any breaking commit wins outright", () => {
    const messages = ["feat: add dropdowns", "chore!: drop support for old API"];
    assert.equal(getIncrementTypeFromMessages(messages), "major");
  });

  await t.test("no releasing commits -> null", () => {
    const messages = ["chore: tidy up", "docs: update readme", "wip"];
    assert.equal(getIncrementTypeFromMessages(messages), null);
  });

  await t.test("empty list -> null", () => {
    assert.equal(getIncrementTypeFromMessages([]), null);
  });
});

test("getCurrentVersion", async (t) => {
  await t.test("uses the published version when it's ahead of package.json", () => {
    assert.equal(getCurrentVersion("1.0.0", "1.2.0"), "1.2.0");
  });

  await t.test("uses package.json when it's been bumped ahead of the registry", () => {
    assert.equal(getCurrentVersion("2.0.0", "1.2.0"), "2.0.0");
  });

  await t.test("uses package.json when nothing is published yet", () => {
    assert.equal(getCurrentVersion("0.1.0", null), "0.1.0");
  });

  await t.test("drops a prerelease suffix", () => {
    assert.equal(getCurrentVersion("1.0.0", "1.2.0-abc1234"), "1.2.0");
  });
});

/**
 * A temp git repo on `main`: the published version's commit (`released`, with a package.json at
 * 1.0.0), a commit whose release run failed or was cancelled (`failedRunAfter`), the pushed
 * commit (`after`), and an unmerged side-branch commit. Removed after the test.
 *
 * @param {import("node:test").TestContext} t
 */
function createRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "generate-version-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execSync(`git ${args}`, { cwd: repo, encoding: "utf8" }).trim();
  const commit = (message) => {
    writeFileSync(join(repo, "file.txt"), message);
    git("add file.txt");
    git(`commit -q -m "${message}"`);
    return git("rev-parse HEAD");
  };

  git("init -q -b main");
  git("config user.email test@example.com");
  git("config user.name test");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "@mapbox/fake", version: "1.0.0" }),
  );
  git("add package.json");
  const released = commit("chore: initial");
  const failedRunAfter = commit("feat: add widgets");
  const after = commit("fix: repair widgets");
  git("checkout -q -b side");
  const sideCommit = commit("chore: side branch");
  git("checkout -q main");

  return { repo, released, failedRunAfter, after, sideCommit };
}

test("getRangeStart", async (t) => {
  const { repo, released, failedRunAfter, after, sideCommit } = createRepo(t);
  const originalCwd = process.cwd();
  process.chdir(repo);
  t.after(() => process.chdir(originalCwd));

  await t.test("starts at the published version's gitHead", () => {
    assert.equal(getRangeStart({ gitHead: released, before: failedRunAfter, after }), released);
  });

  await t.test("counts commits from a failed run toward the next release", () => {
    const start = getRangeStart({ gitHead: released, before: failedRunAfter, after });
    const messages = getCommitMessagesInRange(start, after);
    assert.deepEqual(messages, ["fix: repair widgets", "feat: add widgets"]);
    assert.equal(getIncrementTypeFromMessages(messages), "minor");
  });

  await t.test("falls back to before-sha when the gitHead isn't an ancestor of after-sha", () => {
    assert.equal(
      getRangeStart({ gitHead: sideCommit, before: failedRunAfter, after }),
      failedRunAfter,
    );
  });

  await t.test("falls back to before-sha when the gitHead isn't in this checkout", () => {
    assert.equal(
      getRangeStart({
        gitHead: "0123456789abcdef0123456789abcdef01234567",
        before: failedRunAfter,
        after,
      }),
      failedRunAfter,
    );
  });

  await t.test("falls back to before-sha when the registry has no gitHead", () => {
    assert.equal(getRangeStart({ gitHead: null, before: failedRunAfter, after }), failedRunAfter);
  });

  await t.test("ignores a gitHead that isn't a commit sha", () => {
    assert.equal(
      getRangeStart({ gitHead: "HEAD~2", before: failedRunAfter, after }),
      failedRunAfter,
    );
  });
});

/**
 * Runs the script end to end in a temp repo, with a fake `npm` on PATH standing in for the
 * registry: it prints FAKE_NPM_VIEW, or fails with FAKE_NPM_ERROR's code.
 */
test("main", async (t) => {
  const { repo, released, failedRunAfter, after } = createRepo(t);
  const bin = mkdtempSync(join(tmpdir(), "generate-version-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
[ "$*" = "view @mapbox/fake version gitHead --json" ] || { echo "unexpected: npm $*" >&2; exit 2; }
[ -z "$FAKE_NPM_ERROR" ] || { echo "npm error code $FAKE_NPM_ERROR" >&2; exit 1; }
printf '%s\n' "$FAKE_NPM_VIEW"
`,
    { mode: 0o755 },
  );

  const script = fileURLToPath(new URL("./generate-version.mjs", import.meta.url));
  const output = join(bin, "github-output");
  /** @returns {Record<string, string>} what the script wrote to $GITHUB_OUTPUT */
  const run = (env) => {
    writeFileSync(output, "");
    execFileSync(process.execPath, [script], {
      cwd: repo,
      stdio: "pipe",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        GITHUB_OUTPUT: output,
        ...env,
      },
    });
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  };
  const published = (gitHead) => JSON.stringify({ version: "1.2.0", gitHead });
  const push = {
    GITHUB_REF_NAME: "main",
    BEFORE_SHA: failedRunAfter,
    AFTER_SHA: after,
    GITHUB_SHA: after,
  };

  await t.test(
    "releases every commit since the published version, including a failed run's",
    () => {
      assert.deepEqual(run({ ...push, FAKE_NPM_VIEW: published(released) }), {
        version: "1.3.0",
        skip: "false",
        npm_publish_tag: "latest",
      });
    },
  );

  await t.test("diffs before-sha..after-sha when the registry has no gitHead", () => {
    assert.deepEqual(run({ ...push, FAKE_NPM_VIEW: '"1.2.0"' }), {
      version: "1.2.1",
      skip: "false",
      npm_publish_tag: "latest",
    });
  });

  await t.test("skips when nothing releasable landed since the published version", () => {
    assert.deepEqual(run({ ...push, BEFORE_SHA: released, FAKE_NPM_VIEW: published(after) }), {
      skip: "true",
    });
  });

  await t.test("bumps package.json's version when the package was never published", () => {
    assert.deepEqual(run({ ...push, FAKE_NPM_ERROR: "E404" }), {
      version: "1.0.1",
      skip: "false",
      npm_publish_tag: "latest",
    });
  });

  await t.test("fails instead of treating a registry error as unpublished", () => {
    assert.throws(() => run({ ...push, FAKE_NPM_ERROR: "E401" }));
    assert.equal(readFileSync(output, "utf8"), "");
  });

  await t.test("publishes the next patch as a prerelease off the default branch", () => {
    assert.deepEqual(
      run({ GITHUB_REF_NAME: "feature", GITHUB_SHA: after, FAKE_NPM_VIEW: published(released) }),
      { version: `1.2.1-${after.slice(0, 7)}`, skip: "false", npm_publish_tag: "prerelease" },
    );
  });

  await t.test("publishes a prerelease on the default branch without before/after-sha", () => {
    assert.deepEqual(
      run({ GITHUB_REF_NAME: "main", GITHUB_SHA: after, FAKE_NPM_VIEW: published(released) }),
      { version: `1.2.1-${after.slice(0, 7)}`, skip: "false", npm_publish_tag: "prerelease" },
    );
  });

  await t.test("honours a custom default branch", () => {
    assert.deepEqual(
      run({
        ...push,
        GITHUB_REF_NAME: "master",
        DEFAULT_BRANCH: "master",
        FAKE_NPM_VIEW: published(released),
      }),
      { version: "1.3.0", skip: "false", npm_publish_tag: "latest" },
    );
  });
});
