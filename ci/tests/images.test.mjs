// Structural checks for the image pipeline: .github/workflows/images.yml
// builds the `server` target of deploy/Dockerfile and the agent sandbox image,
// pushes both to GHCR and prints the digest agents.toml pins. Dependency-free
// on purpose (plain text assertions), like release.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');
const WORKFLOW = '.github/workflows/images.yml';

/** The `- image: ...` entries of the build matrix, as objects. */
function matrixEntries(workflow) {
  return [...workflow.matchAll(/^ {10}- image: (\S+)\n((?: {12}\S.*\n)+)/gm)].map((m) => ({
    image: m[1],
    ...Object.fromEntries([...m[2].matchAll(/^ {12}([a-z]+): (.*)$/gm)].map((kv) => [kv[1], kv[2].replace(/^(['"])(.*)\1$/, '$2')])),
  }));
}

test('images.yml runs on v* tags and on manual dispatch only', () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /^on:\n {2}push:\n {4}tags:\s*\[\s*['"]v\*['"]\s*\]\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /pull_request|branches:|schedule:/);
});

test('images.yml builds the server target and the sandbox image from their Dockerfiles', () => {
  const entries = matrixEntries(read(WORKFLOW));
  assert.deepEqual(entries, [
    { image: 'guard-server', dockerfile: 'deploy/Dockerfile', context: '.', target: 'server' },
    { image: 'guard-sandbox', dockerfile: 'deploy/sandbox/Dockerfile', context: 'deploy/sandbox', target: '' },
  ]);
  for (const entry of entries) {
    assert.ok(existsSync(join(repoRoot, entry.dockerfile)), `${entry.dockerfile} exists`);
    assert.ok(existsSync(join(repoRoot, entry.context)), `${entry.context} exists`);
  }
  // The target the workflow builds is a stage of deploy/Dockerfile, and the
  // compose stacks build the same one.
  assert.match(read('deploy/Dockerfile'), /^FROM \S+ AS server$/m);
  const workflow = read(WORKFLOW);
  assert.match(workflow, /docker build/);
  assert.match(workflow, /--file "\$DOCKERFILE"/);
  assert.match(workflow, /--target "\$TARGET"/);
  assert.match(workflow, /fail-fast:\s*false/);
});

test('images.yml pushes both images to GHCR under the lower-cased owner, never as latest', () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /owner="\$\{GITHUB_REPOSITORY_OWNER,,\}"/, 'GHCR rejects upper-case names');
  assert.match(workflow, /ghcr\.io\/\$\{owner\}\/\$\{IMAGE\}/);
  assert.match(workflow, /docker push "\$IMAGE_REF"/);
  // A tag push publishes that tag; a manual run publishes the commit.
  assert.match(workflow, /"\$GITHUB_REF_TYPE" = tag/);
  assert.match(workflow, /tag="\$GITHUB_REF_NAME"/);
  assert.match(workflow, /tag="sha-\$\{GITHUB_SHA:0:12\}"/);
  assert.doesNotMatch(workflow, /:latest\b/);
});

test('images.yml prints each digest in the form agents.toml accepts', () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /\.RepoDigests/);
  // <repo>@sha256:<64 lowercase hex>, the rule of docs/contracts/agents-toml.md.
  assert.ok(workflow.includes("'^ghcr\\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'"), 'the digest is checked before it is printed');
  assert.match(workflow, /echo "digest: \$\{digest\}"/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /GUARD_SANDBOX_IMAGE/, 'the summary names the variable the digest goes into');
});

test('images.yml asks for the least permissions', () => {
  const workflow = read(WORKFLOW);
  // Read-only by default; only the publish job may write packages.
  assert.match(workflow, /^permissions:\n {2}contents: read\n\n/m);
  const granted = [...workflow.matchAll(/^\s+([a-z-]+): (write|read-all|write-all)\b/gm)].map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(granted, ['packages: write']);
  assert.doesNotMatch(workflow, /permissions:\s*(?:write-all|read-all)/);
  assert.match(workflow, /^ {4}permissions:\n {6}contents: read\n {6}packages: write/m);
});

test('images.yml pins every remote action to a full commit SHA', () => {
  const workflow = read(WORKFLOW);
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}$/, ref);
});

test('images.yml only uses actions the other workflows already pin, at the same commit', () => {
  const pinned = new Set(
    ['ci.yml', 'guard.yml', 'pages.yml', 'release.yml'].flatMap((name) =>
      [...read(`.github/workflows/${name}`).matchAll(/uses:\s*(\S+@[0-9a-f]{40})/g)].map((m) => m[1]),
    ),
  );
  const uses = [...read(WORKFLOW).matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  for (const ref of uses) assert.ok(pinned.has(ref), `${ref} is not pinned elsewhere in the repository`);
});

test('the registry token is read from stdin, never put in a command line or printed', () => {
  const workflow = read(WORKFLOW);
  assert.match(workflow, /docker login ghcr\.io --username "\$GITHUB_ACTOR" --password-stdin/);
  assert.doesNotMatch(workflow, /docker login[^\n]*(?:\s-p\s|--password\s|--password=)/);
  // The secret appears once, as an environment variable of the login step.
  const secrets = [...workflow.matchAll(/^.*\$\{\{\s*secrets\.[A-Z_]+\s*\}\}.*$/gm)].map((m) => m[0].trim());
  assert.deepEqual(secrets, ['REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}']);
  assert.doesNotMatch(workflow, /echo[^\n]*REGISTRY_TOKEN/);
});

test('workflow expressions stay out of the shell scripts', () => {
  // Matrix values and step outputs reach `run:` blocks through `env:`.
  const workflow = read(WORKFLOW);
  const runBlocks = [...workflow.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)].map((m) => m[1]);
  assert.ok(runBlocks.length >= 3);
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/, block);
});

test('release.yml stays the binary pipeline: it publishes no image', () => {
  const release = read('.github/workflows/release.yml');
  assert.doesNotMatch(release, /docker|ghcr\.io|packages:/);
});
