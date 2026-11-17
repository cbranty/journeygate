// deploy/dokploy/init.sh is the one-shot init of the Dokploy stack: it clones
// or updates the app checkout, writes agents.toml and thresholds.toml, and
// renders the agent skills. deploy/dokploy/start.sh is the entry point of the
// guard service. Both run here with /bin/sh against local git repositories; a
// stub stands in for guard unless a test says it needs the real binary
// (GUARD_BIN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './compose-text.mjs';

const INIT = join(repoRoot, 'deploy', 'dokploy', 'init.sh');
const START = join(repoRoot, 'deploy', 'dokploy', 'start.sh');
const GUARD_BIN = process.env.GUARD_BIN;
const needsGuard = GUARD_BIN ? {} : { skip: 'set GUARD_BIN to a guard binary' };
const TOKEN = 'ghp_secretTokenValue0123456789';
const CONFIG = {
  GUARD_AGENT_MODEL: 'claude-opus-5-5',
  GUARD_AGENT_BUDGET_USD: '5',
  GUARD_AGENT_DAILY_USD_CAP: '50',
  GUARD_SANDBOX_IMAGE: `ghcr.io/acme/guard-sandbox@sha256:${'a'.repeat(64)}`,
  GUARD_THRESHOLDS_MODE: 'active',
};
const TARGET_TOML = 'version = 1\n\n[app]\nname = "probe"\nbase_url = "http://localhost:3000"\n\n[areas.core]\ndescription = "Everything"\npaths = ["src/**"]\n';
// Records every call; `agents sync` creates what the real command creates.
const GUARD_STUB = `#!/bin/sh
printf '%s|%s|%s\\n' "$*" "\${GUARD_AGENTS_TOML:-}" "$PWD" >> "$GUARD_STUB_LOG"
case "$1 $2" in
  "agents check") exit "\${GUARD_STUB_CHECK_EXIT:-0}" ;;
  "agents sync") mkdir -p .guard/agents/rendered/claude-code; exit "\${GUARD_STUB_SYNC_EXIT:-0}" ;;
esac
`;

/** A scratch world: an origin repository, an empty checkout, a config dir and the stub. */
function world(t, { files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-init-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {
    dir,
    origin: join(dir, 'origin'),
    checkout: join(dir, 'checkout'),
    config: join(dir, 'config'),
    log: join(dir, 'guard-calls.log'),
    stub: join(dir, 'guard-stub'),
    // No user or system git configuration leaks into a test.
    gitEnv: { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: dir },
  };
  writeFileSync(paths.gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = test\n\temail = test@example.invalid\n');
  writeFileSync(paths.stub, GUARD_STUB);
  chmodSync(paths.stub, 0o755);
  mkdirSync(paths.checkout);
  mkdirSync(paths.origin);
  git(paths, paths.origin, 'init', '--quiet', '--initial-branch', 'main');
  commit(paths, {
    'target.toml': TARGET_TOML,
    'e2e-playwright/catalog/journeys.json': '{"journeys": []}\n',
    'README.md': 'app\n',
    ...files,
  });
  return paths;
}

function git(paths, cwd, ...args) {
  const run = spawnSync('git', args, { cwd, env: { PATH: process.env.PATH, ...paths.gitEnv }, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/** Writes `files` into the origin repository and commits them. */
function commit(paths, files, message = 'change') {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(paths.origin, rel, '..'), { recursive: true });
    writeFileSync(join(paths.origin, rel), content);
  }
  git(paths, paths.origin, 'add', '--all');
  git(paths, paths.origin, 'commit', '--quiet', '--message', message);
  return git(paths, paths.origin, 'rev-parse', 'HEAD');
}

function initEnv(paths, env = {}) {
  return {
    PATH: process.env.PATH,
    ...paths.gitEnv,
    GUARD_INIT_CHECKOUT: paths.checkout,
    GUARD_INIT_CONFIG_DIR: paths.config,
    GUARD_BIN: paths.stub,
    GUARD_STUB_LOG: paths.log,
    GUARD_APP_REPO_URL: `file://${paths.origin}`,
    ...CONFIG,
    ...env,
  };
}

const init = (paths, env) => spawnSync('/bin/sh', [INIT], { env: initEnv(paths, env), encoding: 'utf8' });
const head = (paths) => git(paths, paths.checkout, 'rev-parse', 'HEAD');
const calls = (paths) => (existsSync(paths.log) ? readFileSync(paths.log, 'utf8').trim().split('\n') : []);
const output = (run) => `${run.stdout}${run.stderr}`;

test('a first deploy clones the repository, writes the config and checks it', (t) => {
  const paths = world(t);
  const sha = git(paths, paths.origin, 'rev-parse', 'HEAD');
  const run = init(paths, { GITHUB_TOKEN: TOKEN });
  assert.equal(run.status, 0, output(run));
  assert.equal(head(paths), sha);
  assert.equal(readFileSync(join(paths.checkout, 'target.toml'), 'utf8'), TARGET_TOML);
  assert.equal(git(paths, paths.checkout, 'status', '--porcelain'), '', 'a clean working tree');
  assert.equal(git(paths, paths.checkout, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
  assert.deepEqual(readdirSync(paths.config).sort(), ['agents.toml', 'thresholds.toml']);
  // guard agents check ran in the checkout against the written file; no
  // agents/AGENTS.md, so there is nothing to render.
  assert.deepEqual(calls(paths), [`agents check|${join(paths.config, 'agents.toml')}|${paths.checkout}`]);
  assert.match(run.stdout, /no agents\/AGENTS\.md/);
});

test('the clone leaves no credential in .git/config or in the output', (t) => {
  const paths = world(t);
  const run = init(paths, { GITHUB_TOKEN: TOKEN });
  assert.equal(run.status, 0, output(run));
  const config = readFileSync(join(paths.checkout, '.git', 'config'), 'utf8');
  assert.match(config, /url = file:\/\//);
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  for (const secret of [TOKEN, basic, 'extraHeader', 'x-access-token', 'Authorization']) {
    assert.ok(!config.includes(secret), `.git/config holds ${secret}`);
    assert.ok(!output(run).includes(secret), `the output holds ${secret}`);
  }
});

test('the skills are rendered when the repository has agents/AGENTS.md', (t) => {
  const paths = world(t, { files: { 'agents/AGENTS.md': '# Conventions\n' } });
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  const agentsToml = join(paths.config, 'agents.toml');
  assert.deepEqual(calls(paths), [
    `agents check|${agentsToml}|${paths.checkout}`,
    `agents sync|${agentsToml}|${paths.checkout}`,
  ]);
  assert.ok(existsSync(join(paths.checkout, '.guard', 'agents', 'rendered')));
});

test('a second deploy keeps .guard/ and fast-forwards to the new commit', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  mkdirSync(join(paths.checkout, '.guard', 'agents', 'work'), { recursive: true });
  writeFileSync(join(paths.checkout, '.guard', 'agents', 'work', 'state'), 'kept\n');
  git(paths, paths.checkout, 'branch', 'agent/SHOP-1');
  const next = commit(paths, { 'README.md': 'app v2\n' });
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.equal(head(paths), next);
  assert.equal(readFileSync(join(paths.checkout, 'README.md'), 'utf8'), 'app v2\n');
  assert.equal(readFileSync(join(paths.checkout, '.guard', 'agents', 'work', 'state'), 'utf8'), 'kept\n');
  assert.match(git(paths, paths.checkout, 'branch', '--list', 'agent/SHOP-1'), /agent\/SHOP-1/);
});

test('a second deploy with nothing new succeeds and changes nothing', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  const before = head(paths);
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.equal(run.stderr, '');
  assert.equal(head(paths), before);
});

test('a second deploy does not fail when the remote cannot be reached', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  const before = head(paths);
  rmSync(paths.origin, { recursive: true, force: true });
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.match(run.stderr, /^warning: .*cannot fetch/m);
  assert.equal(head(paths), before);
});

test('a checkout that cannot fast-forward is left as it is, with a warning', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  writeFileSync(join(paths.checkout, 'local.txt'), 'local\n');
  git(paths, paths.checkout, 'add', 'local.txt');
  git(paths, paths.checkout, 'commit', '--quiet', '--message', 'local work');
  const local = head(paths);
  mkdirSync(join(paths.checkout, '.guard'));
  writeFileSync(join(paths.checkout, '.guard', 'state'), 'kept\n');
  commit(paths, { 'README.md': 'app v2\n' });
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.match(run.stderr, /^warning: .*fast-forward/m);
  assert.equal(head(paths), local);
  assert.equal(readFileSync(join(paths.checkout, '.guard', 'state'), 'utf8'), 'kept\n');
});

test('a file guard wrote here that the repository starts tracking does not block a later deploy', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  const before = head(paths);
  // What `guard agents sync` leaves behind, plus state that must survive.
  writeFileSync(join(paths.checkout, 'AGENTS.md'), 'generated here\n');
  writeFileSync(join(paths.checkout, 'notes.txt'), 'untracked and not upstream\n');
  mkdirSync(join(paths.checkout, '.guard'));
  writeFileSync(join(paths.checkout, '.guard', 'state'), 'kept\n');
  commit(paths, { 'AGENTS.md': 'committed upstream\n', 'README.md': 'app v2\n' });
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.doesNotMatch(run.stderr, /fast-forward/);
  assert.notEqual(head(paths), before);
  assert.equal(readFileSync(join(paths.checkout, 'README.md'), 'utf8'), 'app v2\n');
  assert.equal(readFileSync(join(paths.checkout, 'AGENTS.md'), 'utf8'), 'committed upstream\n');
  assert.equal(readFileSync(join(paths.checkout, 'notes.txt'), 'utf8'), 'untracked and not upstream\n');
  assert.equal(readFileSync(join(paths.checkout, '.guard', 'state'), 'utf8'), 'kept\n');
});

test('a tracked file changed in the checkout still blocks the update, and is kept', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  const before = head(paths);
  writeFileSync(join(paths.checkout, 'README.md'), 'edited in the checkout\n');
  commit(paths, { 'README.md': 'app v2\n' });
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.match(run.stderr, /^warning: .*fast-forward/m);
  assert.equal(head(paths), before);
  assert.equal(readFileSync(join(paths.checkout, 'README.md'), 'utf8'), 'edited in the checkout\n');
});

test('a checkout directory that already holds .guard/ but no clone is cloned into', (t) => {
  const paths = world(t);
  mkdirSync(join(paths.checkout, '.guard'));
  writeFileSync(join(paths.checkout, '.guard', 'state'), 'kept\n');
  const run = init(paths);
  assert.equal(run.status, 0, output(run));
  assert.equal(head(paths), git(paths, paths.origin, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(paths.checkout, '.guard', 'state'), 'utf8'), 'kept\n');
  assert.deepEqual(
    readdirSync(paths.checkout).filter((name) => name.startsWith('.guard-init')),
    [],
    'no temporary clone is left behind',
  );
});

test('GUARD_APP_REPO_REF selects the branch of the first clone', (t) => {
  const paths = world(t);
  git(paths, paths.origin, 'checkout', '--quiet', '-b', 'release');
  const release = commit(paths, { 'README.md': 'release\n' });
  git(paths, paths.origin, 'checkout', '--quiet', 'main');
  const run = init(paths, { GUARD_APP_REPO_REF: 'release' });
  assert.equal(run.status, 0, output(run));
  assert.equal(head(paths), release);
  assert.equal(git(paths, paths.checkout, 'symbolic-ref', '--short', 'HEAD'), 'release');
});

test('a changed GUARD_APP_REPO_REF does not move an existing checkout', (t) => {
  const paths = world(t);
  git(paths, paths.origin, 'branch', 'release');
  assert.equal(init(paths).status, 0);
  const before = head(paths);
  const run = init(paths, { GUARD_APP_REPO_REF: 'release' });
  assert.equal(run.status, 0, output(run));
  assert.match(run.stderr, /^warning: .*GUARD_APP_REPO_REF/m);
  assert.equal(head(paths), before);
  assert.equal(git(paths, paths.checkout, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('a changed GUARD_APP_REPO_URL does not touch an existing checkout', (t) => {
  const paths = world(t);
  assert.equal(init(paths).status, 0);
  const before = head(paths);
  const run = init(paths, { GUARD_APP_REPO_URL: `file://${paths.dir}/another` });
  assert.equal(run.status, 0, output(run));
  assert.match(run.stderr, /^warning: .*GUARD_APP_REPO_URL/m);
  assert.equal(head(paths), before);
});

test('the clone URL is derived from GITHUB_REPOSITORY and GITLAB_PROJECT', (t) => {
  for (const [env, derived] of [
    [{ GITHUB_REPOSITORY: 'acme/shop' }, 'https://github.com/acme/shop.git'],
    [{ GITHUB_REPOSITORY: 'acme/shop', GITHUB_API_URL: 'https://api.github.com/' }, 'https://github.com/acme/shop.git'],
    [{ GITLAB_PROJECT: 'acme/team/shop' }, 'https://gitlab.com/acme/team/shop.git'],
    [{ GITLAB_PROJECT: 'acme/shop', GITLAB_API_URL: 'https://gitlab.com/api/v4' }, 'https://gitlab.com/acme/shop.git'],
  ]) {
    const paths = world(t);
    // git itself rewrites the public URL to the local origin: no network.
    writeFileSync(
      paths.gitEnv.GIT_CONFIG_GLOBAL,
      `[user]\n\tname = test\n\temail = test@example.invalid\n[url "file://${paths.origin}"]\n\tinsteadOf = ${derived}\n`,
    );
    const run = init(paths, { GUARD_APP_REPO_URL: '', ...env });
    assert.equal(run.status, 0, output(run));
    assert.equal(git(paths, paths.checkout, 'config', '--local', '--get', 'remote.origin.url'), derived);
  }
});

const NO_URL = [
  [{}, 'no repository variable at all'],
  [{ GITHUB_REPOSITORY: 'acme/shop', GITHUB_API_URL: 'https://github.example.com/api/v3' }, 'GitHub Enterprise'],
  [{ GITLAB_PROJECT: '4242' }, 'a numeric GitLab project id'],
  [{ GITLAB_PROJECT: 'acme/shop', GITLAB_API_URL: 'https://gitlab.example.com/api/v4' }, 'self-managed GitLab'],
];
for (const [env, why] of NO_URL) {
  test(`GUARD_APP_REPO_URL is required with ${why}`, (t) => {
    const paths = world(t);
    const run = init(paths, { GUARD_APP_REPO_URL: '', ...env });
    assert.equal(run.status, 2, output(run));
    assert.match(run.stderr, /^error: GUARD_APP_REPO_URL: /m);
    assert.ok(!existsSync(join(paths.checkout, '.git')));
    assert.deepEqual(calls(paths), []);
  });
}

const BAD_URLS = [
  [`https://x-access-token:${TOKEN}@github.com/acme/shop.git`, 'embedded credentials'],
  [`https://${TOKEN}@github.com/acme/shop.git`, 'an embedded token'],
  ['http://git.example.com/acme/shop.git', 'cleartext http to another host'],
  ['git@github.com:acme/shop.git', 'an ssh remote'],
  ['--upload-pack=touch /tmp/x', 'an option instead of a URL'],
  ['https://github.com/acme/shop.git\nhttps://evil.example', 'two lines'],
];
for (const [url, why] of BAD_URLS) {
  test(`GUARD_APP_REPO_URL with ${why} is refused and not echoed`, (t) => {
    const paths = world(t);
    const run = init(paths, { GUARD_APP_REPO_URL: url, GITHUB_TOKEN: TOKEN });
    assert.equal(run.status, 2, output(run));
    assert.match(run.stderr, /^error: GUARD_APP_REPO_URL: /m);
    assert.ok(!output(run).includes(TOKEN));
    assert.ok(!existsSync(join(paths.checkout, '.git')));
  });
}

test('a GUARD_APP_REPO_REF that is not a branch or tag name is refused', (t) => {
  const paths = world(t);
  const run = init(paths, { GUARD_APP_REPO_REF: '--upload-pack=x' });
  assert.equal(run.status, 2, output(run));
  assert.match(run.stderr, /^error: GUARD_APP_REPO_REF: /m);
  assert.ok(!existsSync(join(paths.checkout, '.git')));
});

test('a first clone that fails stops the deploy and leaves no half checkout', (t) => {
  const paths = world(t);
  const run = init(paths, { GUARD_APP_REPO_URL: `file://${paths.dir}/missing`, GITHUB_TOKEN: TOKEN });
  assert.equal(run.status, 1, output(run));
  assert.match(run.stderr, /^error: cannot clone the app repository/m);
  assert.deepEqual(readdirSync(paths.checkout), []);
  assert.ok(!output(run).includes(TOKEN));
});

for (const [missing, files] of [
  ['target.toml', { 'e2e-playwright/catalog/journeys.json': '{}\n' }],
  ['e2e-playwright/catalog/journeys.json', { 'target.toml': TARGET_TOML }],
]) {
  test(`a repository without ${missing} stops the deploy with a message that names it`, (t) => {
    const paths = world(t);
    git(paths, paths.origin, 'rm', '--quiet', '-r', '.');
    commit(paths, { 'README.md': 'app\n', ...files }, 'drop a required file');
    const run = init(paths);
    assert.equal(run.status, 2, output(run));
    assert.ok(run.stderr.includes(`error: the app repository has no ${missing}`), run.stderr);
    assert.deepEqual(calls(paths), []);
  });
}

test('a bad agent variable stops the deploy before guard is called', (t) => {
  const paths = world(t);
  const run = init(paths, { GUARD_SANDBOX_IMAGE: 'ghcr.io/acme/guard-sandbox:latest' });
  assert.equal(run.status, 2, output(run));
  assert.match(run.stderr, /^error: GUARD_SANDBOX_IMAGE: /m);
  assert.deepEqual(calls(paths), []);
  assert.ok(!existsSync(join(paths.config, 'agents.toml')));
});

test('an agents.toml that guard agents check rejects stops the deploy', (t) => {
  const paths = world(t, { files: { 'agents/AGENTS.md': '# Conventions\n' } });
  const run = init(paths, { GUARD_STUB_CHECK_EXIT: '2' });
  assert.equal(run.status, 2, output(run));
  assert.match(run.stderr, /^error: .*guard agents check/m);
  assert.equal(calls(paths).length, 1, 'guard agents sync is not run');
});

test('a failing guard agents sync stops the deploy', (t) => {
  const paths = world(t, { files: { 'agents/AGENTS.md': '# Conventions\n' } });
  const run = init(paths, { GUARD_STUB_SYNC_EXIT: '2' });
  assert.equal(run.status, 1, output(run));
  assert.match(run.stderr, /^error: .*guard agents sync/m);
});

// The token must reach the code host as a header, never in the URL or argv.
for (const [env, user] of [
  [{ GITHUB_TOKEN: TOKEN }, 'x-access-token'],
  [{ GITLAB_TOKEN: TOKEN }, 'oauth2'],
]) {
  test(`the ${user} token is sent as a basic-auth header to the clone URL only`, async (t) => {
    const paths = world(t);
    const seen = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(500).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/acme/shop.git`;
    const child = spawn('/bin/sh', [INIT], { env: initEnv(paths, { GUARD_APP_REPO_URL: url, ...env }) });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const status = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(status, 1, out);
    assert.ok(seen.length > 0, 'git reached the server');
    assert.match(seen[0].url, /^\/acme\/shop\.git\/info\/refs/);
    assert.equal(seen[0].authorization, `Basic ${Buffer.from(`${user}:${TOKEN}`).toString('base64')}`);
    assert.ok(!out.includes(TOKEN), 'the token is not printed');
  });
}

test('without a token the clone is anonymous', async (t) => {
  const paths = world(t);
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/acme/shop.git`;
  const child = spawn('/bin/sh', [INIT], { env: initEnv(paths, { GUARD_APP_REPO_URL: url }) });
  child.stdout.resume();
  child.stderr.resume();
  await new Promise((resolve) => child.on('close', resolve));
  assert.ok(seen.length > 0);
  assert.equal(seen[0], undefined);
});

test('the real guard accepts the config and renders the skills', needsGuard, (t) => {
  const paths = world(t, {
    files: {
      'agents/AGENTS.md': '# Conventions\n\nRun the tests before you finish.\n',
      'agents/skills/run-tests/SKILL.md': '---\nname: run-tests\ndescription: Use when a change needs its tests run.\n---\n\nRun `guard test`.\n',
    },
  });
  const run = init(paths, { GUARD_BIN });
  assert.equal(run.status, 0, output(run));
  const rendered = join(paths.checkout, '.guard', 'agents', 'rendered', 'claude-code');
  assert.ok(existsSync(join(rendered, 'AGENTS.md')));
  assert.ok(existsSync(join(rendered, 'skills', 'run-tests', 'SKILL.md')));
  // Only the runtime agents.toml names is rendered.
  assert.deepEqual(readdirSync(join(paths.checkout, '.guard', 'agents', 'rendered')), ['claude-code']);
  // A second deploy over the rendered checkout still succeeds.
  const again = init(paths, { GUARD_BIN });
  assert.equal(again.status, 0, output(again));
});

// ---- start.sh: the entry point of the guard service --------------------------------

function startWorld(t) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { dir, log: join(dir, 'guard-calls.log'), stub: join(dir, 'guard-stub') };
  writeFileSync(paths.stub, GUARD_STUB);
  chmodSync(paths.stub, 0o755);
  writeFileSync(join(dir, 'agents.toml'), 'version = 1\n');
  writeFileSync(join(dir, 'thresholds.toml'), 'version = 1\n');
  return paths;
}

function start(paths, env = {}) {
  return spawnSync('/bin/sh', [START, 'serve', '--repo', '/repo'], {
    cwd: paths.dir,
    env: {
      PATH: process.env.PATH,
      GUARD_BIN: paths.stub,
      GUARD_STUB_LOG: paths.log,
      GUARD_AGENTS_TOML: join(paths.dir, 'agents.toml'),
      GUARD_THRESHOLDS: join(paths.dir, 'thresholds.toml'),
      ...env,
    },
    encoding: 'utf8',
  });
}

test('start.sh checks the agents file, then runs guard with its arguments', (t) => {
  const paths = startWorld(t);
  const run = start(paths);
  assert.equal(run.status, 0, output(run));
  const agentsToml = join(paths.dir, 'agents.toml');
  assert.deepEqual(calls(paths), [`agents check|${agentsToml}|${paths.dir}`, `serve --repo /repo|${agentsToml}|${paths.dir}`]);
});

for (const name of ['GUARD_AGENTS_TOML', 'GUARD_THRESHOLDS']) {
  test(`start.sh refuses to start when ${name} names no file`, (t) => {
    const paths = startWorld(t);
    for (const value of ['', join(paths.dir, 'missing.toml')]) {
      const run = start(paths, { [name]: value });
      assert.equal(run.status, 2, output(run));
      assert.match(run.stderr, new RegExp(`^error: ${name}: `, 'm'));
    }
    assert.deepEqual(calls(paths), [], 'guard serve never ran');
  });
}

test('start.sh refuses to start when guard agents check rejects the file', (t) => {
  const paths = startWorld(t);
  const run = start(paths, { GUARD_STUB_CHECK_EXIT: '2' });
  assert.equal(run.status, 2, output(run));
  assert.match(run.stderr, /^error: .*guard agents check/m);
  assert.equal(calls(paths).length, 1, 'guard serve never ran');
});
