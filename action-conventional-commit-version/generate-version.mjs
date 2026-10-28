#!/usr/bin/env node
/**
 * Prints the version to publish, using the package registry (not git tags) as the source of
 * truth. On a push to main, bumps based on Conventional Commits since the last release; otherwise
 * publishes the next 'patch' + `-<shortsha>` prerelease. See action.yml / README.md for I/O. No
 * third-party deps.
 */
import { execSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const HEADER_RE = /^(\w+)(\([^)]*\))?(!)?:\s?(.*)$/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;
const INCREMENT_TYPES = ["patch", "minor", "major"];

/**
 * @param {string} version e.g. "1.2.3-abc1234"
 * @returns {[number, number, number]} e.g. [1, 2, 3]
 */
export function releaseCore(version) {
  return version.split("-")[0].split(".").map(Number);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} positive if a > b, negative if a < b, 0 if equal (prerelease ignored)
 */
export function compareVersions(a, b) {
  const partsA = releaseCore(a);
  const partsB = releaseCore(b);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] !== partsB[i]) {
      return partsA[i] - partsB[i];
    }
  }
  return 0;
}

/**
 * @param {string} version
 * @param {"patch"|"minor"|"major"} type
 * @returns {string}
 */
export function increment(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") {
    return `${major + 1}.0.0`;
  }
  if (type === "minor") {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Bump for one commit message, or null if it doesn't warrant a release. feat -> minor;
 * fix/perf/revert -> patch; `!` after type/scope or a BREAKING CHANGE: footer -> major
 * regardless of type; anything else (chore, docs, ..., or non-conventional) -> null.
 *
 * @param {string} message header plus body/footer
 * @returns {"major"|"minor"|"patch"|null}
 */
export function getIncrementTypeForMessage(message) {
  const header = message.split("\n", 1)[0];
  const match = header.match(HEADER_RE);
  if (!match) {
    return null;
  }

  const [, type, , bang] = match;
  if (bang || BREAKING_FOOTER_RE.test(message)) {
    return "major";
  }
  if (type === "feat") {
    return "minor";
  }
  if (type === "fix" || type === "perf" || type === "revert") {
    return "patch";
  }
  return null;
}

/**
 * @param {string[]} messages
 * @returns {"major"|"minor"|"patch"|null} the highest bump across all messages, or null if none
 *   warrant a release
 */
export function getIncrementTypeFromMessages(messages) {
  let incrementType = null;
  for (const message of messages) {
    const thisIncrement = getIncrementTypeForMessage(message);
    if (
      thisIncrement &&
      (!incrementType ||
        INCREMENT_TYPES.indexOf(thisIncrement) > INCREMENT_TYPES.indexOf(incrementType))
    ) {
      incrementType = thisIncrement;
    }
    if (incrementType === "major") {
      break;
    }
  }
  return incrementType;
}

/**
 * Get the published version and its commit sha.
 * Throws on anything else (auth/network/unexpected output).
 *
 * @param {string} name package name
 * @returns {{ version: string, gitHead: string|null }|null}
 */
function getPublished(name) {
  let stdout;
  try {
    stdout = execSync(`npm view ${name} version gitHead --json`, { encoding: "utf8" });
  } catch (err) {
    if (/\bE404\b/.test(err.stderr || "")) {
      return null;
    }
    throw err;
  }
  const parsed = JSON.parse(stdout);
  const { version, gitHead = null } = typeof parsed === "string" ? { version: parsed } : parsed;
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Unexpected \`npm view\` output: ${JSON.stringify(stdout)}`);
  }
  return { version, gitHead };
}

/**
 * @param {string} packageVersion package.json's version
 * @param {string|null} published the registry's version
 * @returns {string} the higher of the two, as x.y.z
 */
export function getCurrentVersion(packageVersion, published) {
  const maxVersion =
    !published || compareVersions(packageVersion, published) > 0 ? packageVersion : published;
  return releaseCore(maxVersion).join(".");
}

/** @returns {string} the current commit's short sha */
function shortSha() {
  return (process.env.GITHUB_SHA || execSync("git rev-parse HEAD", { encoding: "utf8" })).slice(
    0,
    7,
  );
}

/**
 * Full messages (header + body/footer, so a footer BREAKING CHANGE: is visible), one per
 * commit. Empty (treated as "no releasing commits") if diff fails for whatever reason.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
export function getCommitMessagesInRange(before, after) {
  const RECORD_SEP = "\x1e";
  let log;
  try {
    log = execSync(`git log ${before}..${after} --format=%B${RECORD_SEP}`, { encoding: "utf8" });
  } catch (err) {
    console.error(
      `Failed to diff ${before}..${after}, release will be skipped.\n${err.stderr || err.message}`,
    );
    return [];
  }

  return log
    .split(RECORD_SEP)
    .map((message) => message.trim())
    .filter(Boolean);
}

/**
 * Ensure we pick up commits from failed/cancelled jobs by starting from the last version when possible.
 *
 * @param {{ gitHead: string|null, before: string, after: string }} options
 * @returns {string} the commit to use as the start of `git log <start>..<after>`
 */
export function getRangeStart({ gitHead, before, after }) {
  if (!gitHead || !/^[0-9a-f]{7,40}$/.test(gitHead)) {
    return before;
  }
  try {
    execSync(`git merge-base --is-ancestor ${gitHead} ${after}`, { stdio: "ignore" });
    return gitHead;
  } catch {
    return before;
  }
}

/** Reads env/package.json, resolves the version, and writes $GITHUB_OUTPUT. */
function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const published = getPublished(pkg.name);
  const current = getCurrentVersion(pkg.version, published?.version ?? null);
  const isMainBranch = Boolean(
    process.env.GITHUB_REF_NAME === (process.env.DEFAULT_BRANCH || "main") &&
    process.env.BEFORE_SHA &&
    process.env.AFTER_SHA,
  );

  let version;
  if (isMainBranch) {
    const start = getRangeStart({
      gitHead: published?.gitHead ?? null,
      before: process.env.BEFORE_SHA,
      after: process.env.AFTER_SHA,
    });
    console.log(`Considering commits in ${start}..${process.env.AFTER_SHA}`);
    const incrementType = getIncrementTypeFromMessages(
      getCommitMessagesInRange(start, process.env.AFTER_SHA),
    );
    version = incrementType ? increment(current, incrementType) : null;
  } else {
    // pre-release gets patch bump + sha
    version = `${increment(current, "patch")}-${shortSha()}`;
  }

  /**
   * Publishing a prerelease under "latest" (npm publish's default tag) would corrupt
   * getPublished's read on every future run, so non-main builds get their own tag.
   * @type {"latest"|"prerelease"}
   */
  const npmTag = isMainBranch ? "latest" : "prerelease";

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      version ? `version=${version}\nskip=false\nnpm_publish_tag=${npmTag}\n` : "skip=true\n",
    );
  }

  console.log(
    `Found latest version: ${current}\nVersion to be released: ${
      version || "(skipped release, no relevant commits found)"
    }`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
