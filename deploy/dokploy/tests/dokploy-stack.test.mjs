// Structural checks for the Dokploy stack: deploy/docker-compose.dokploy.yml,
// its environment template, the scripts the server image ships for it, and
// deploy/DOKPLOY.md. Plain text assertions: they prove the files agree with
// each other, not that a container starts (no Docker here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  inlineScript,
  interpolatedVariables,
  passThroughVariables,
  read,
  repoRoot,
  serviceBlock,
  serviceNames,
  templateVariables,
} from './compose-text.mjs';

const DOKPLOY = 'deploy/docker-compose.dokploy.yml';
const TEMPLATE = 'deploy/env.dokploy.example';
const SCRIPTS = ['init.sh', 'render-config.sh', 'start.sh'];
const environmentKeys = (block) => [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);

test('one file runs the whole stack, with no profile and no fixed project name', () => {
  const compose = read(DOKPLOY);
  assert.deepEqual(serviceNames(compose).sort(), [
    'guard',
    'litellm',
    'postgres',
    'redis',
    'repo-init',
    's3',
    's3-init',
    'volume-init',
  ]);
  assert.doesNotMatch(compose, /^\s+profiles:/m);
  assert.doesNotMatch(compose, /^name:/m, 'Dokploy sets the project name');
  assert.doesNotMatch(compose, /^\s+container_name:/m);
});

test('every variable the compose file reads is in the template, and the template has no other', () => {
  const compose = read(DOKPLOY);
  const used = [...new Set([...interpolatedVariables(compose), ...passThroughVariables(compose)])].sort();
  assert.deepEqual(templateVariables(read(TEMPLATE)), used);
});

test('the template lists every variable once, by name only, under a one-line comment', () => {
  const lines = read(TEMPLATE).split('\n');
  const seen = new Set();
  lines.forEach((line, i) => {
    const name = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!name) return;
    assert.equal(name[2], '', `${name[1]} holds a value`);
    assert.ok(!seen.has(name[1]), `${name[1]} is listed twice`);
    seen.add(name[1]);
    assert.match(lines[i - 1] ?? '', /^# (?!----)\S/, `${name[1]} has no comment`);
    assert.doesNotMatch(lines[i - 2] ?? '', /^# (?!----)/, `${name[1]}: the comment is one line`);
  });
  assert.ok(seen.size > 0);
});

test('guard carries the agent-lane wiring of docker-compose.agents.yml', () => {
  const guard = serviceBlock(read(DOKPLOY), 'guard');
  assert.match(guard, /^ {6}- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/m);
  assert.match(guard, /^ {4}group_add:\n {6}- "\$\{DOCKER_GID:\?[^}]+\}"$/m);
  assert.match(guard, /^ {6}LITELLM_MASTER_KEY: \$\{LITELLM_MASTER_KEY:\?[^}]+\}$/m);
  assert.match(guard, /^ {6}GUARD_GATEWAY_ADMIN_URL: http:\/\/litellm:4000$/m);
  assert.match(guard, /^ {6}GUARD_SANDBOX_EGRESS_NETWORK: guard-gateway$/m);
  assert.match(guard, /^ {4}networks: \[default, gateway\]$/m);
  assert.match(guard, /^ {6}litellm:\n {8}condition: service_healthy$/m);
});

test('the agent work dir has one path on the host, in guard and in volume-init', () => {
  const compose = read(DOKPLOY);
  const reference = '${GUARD_AGENT_WORK_DIR:-/var/lib/guard/agent-work}';
  for (const service of ['guard', 'volume-init']) {
    const block = serviceBlock(compose, service);
    assert.ok(block.includes(`      - ${reference}:${reference}\n`), `${service} mounts it at the same path`);
    assert.ok(block.includes(`      GUARD_AGENT_WORK_DIR: ${reference}\n`), `${service} is told the same path`);
  }
  // A named volume cannot be the work dir: the host engine resolves the path.
  assert.doesNotMatch(compose, /^ {2}(?:agent-)?work(?:-dir)?:\s*$/m);
});

test('guard keeps every variable the two-file stack gives it', () => {
  const twoFiles = [
    ...environmentKeys(serviceBlock(read('deploy/docker-compose.yml'), 'guard')),
    ...environmentKeys(serviceBlock(read('deploy/docker-compose.agents.yml'), 'guard')),
  ];
  const dokploy = new Set(environmentKeys(serviceBlock(read(DOKPLOY), 'guard')));
  assert.deepEqual(twoFiles.filter((name) => !dokploy.has(name)), []);
});

test('the egress network has a fixed name that no project name changes', () => {
  const compose = read(DOKPLOY);
  const networks = compose.slice(compose.search(/^networks:$/m), compose.search(/^volumes:$/m));
  assert.match(networks, /^ {2}gateway:\n {4}name: guard-gateway$/m);
  assert.doesNotMatch(networks, /\$\{/);
  assert.match(serviceBlock(compose, 'litellm'), /^ {4}networks: \[default, gateway\]$/m);
});

test('guard is reached through a domain: port 8080 is exposed, not published', () => {
  const guard = serviceBlock(read(DOKPLOY), 'guard');
  assert.match(guard, /^ {4}expose:\n {6}- "8080"$/m);
  assert.doesNotMatch(guard, /^ {4}ports:/m);
});

test('the evidence host comes from the environment for guard and for the store', () => {
  const compose = read(DOKPLOY);
  assert.match(serviceBlock(compose, 'guard'), /^ {6}GUARD_STORAGE_URL: s3\+http:\/\/.+@\$\{S3_PUBLIC_HOST:\?[^}]+\}:8333\/\$\{S3_BUCKET:-guard-evidence\}$/m);
  const store = serviceBlock(compose, 's3');
  assert.match(store, /^ {10}- \$\{S3_PUBLIC_HOST:\?[^}]+\}$/m);
  assert.match(store, /^ {6}- "8333:8333"$/m);
});

test('nothing is bind-mounted from the repository Dokploy clones on every deploy', () => {
  const compose = read(DOKPLOY);
  assert.doesNotMatch(compose, /^\s+- \.{1,2}\//m);
  // What the two-file stack mounts from deploy/ is built into images here.
  assert.match(serviceBlock(compose, 'litellm'), /^ {8}COPY config\.yaml \/app\/config\.yaml$/m);
  assert.match(serviceBlock(compose, 'postgres'), /^ {8}COPY init\/ \/docker-entrypoint-initdb\.d\/$/m);
  assert.ok(existsSync(join(repoRoot, 'deploy', 'litellm', 'config.yaml')));
  assert.ok(existsSync(join(repoRoot, 'deploy', 'postgres', 'init')));
});

test('the init steps run in order, and only the first one is root', () => {
  const compose = read(DOKPLOY);
  const volumeInit = serviceBlock(compose, 'volume-init');
  const repoInit = serviceBlock(compose, 'repo-init');
  const guard = serviceBlock(compose, 'guard');
  assert.match(volumeInit, /^ {4}user: "0:0"$/m);
  const chown = inlineScript(compose, 'volume-init', 'command');
  assert.match(chown, /for dir in \/repo \/config "\$GUARD_AGENT_WORK_DIR"; do/);
  assert.match(chown, /chown 10001:10001 "\$dir"/);
  for (const block of [repoInit, guard]) assert.doesNotMatch(block, /^ {4}user:/m, 'the image user (guard) is kept');
  assert.match(repoInit, /^ {6}volume-init:\n {8}condition: service_completed_successfully$/m);
  assert.match(guard, /^ {6}repo-init:\n {8}condition: service_completed_successfully$/m);
  // The init steps never get the engine socket.
  for (const block of [volumeInit, repoInit]) assert.doesNotMatch(block, /docker\.sock/);
});

test('guard reads the files repo-init writes, read-only', () => {
  const compose = read(DOKPLOY);
  const guard = serviceBlock(compose, 'guard');
  assert.match(guard, /^ {6}GUARD_AGENTS_TOML: \/config\/agents\.toml$/m);
  assert.match(guard, /^ {6}GUARD_THRESHOLDS: \/config\/thresholds\.toml$/m);
  assert.match(guard, /^ {6}- guard-config:\/config:ro$/m);
  assert.match(guard, /^ {6}- repo:\/repo$/m);
  const repoInit = serviceBlock(compose, 'repo-init');
  assert.match(repoInit, /^ {6}- guard-config:\/config$/m);
  assert.match(repoInit, /^ {6}- repo:\/repo$/m);
  // The init script's defaults are the paths the compose file mounts.
  const init = read('deploy/dokploy/init.sh');
  assert.match(init, /^checkout=\$\{GUARD_INIT_CHECKOUT:-\/repo\}$/m);
  assert.match(init, /^config=\$\{GUARD_INIT_CONFIG_DIR:-\/config\}$/m);
});

test('repo-init gets every variable its scripts read', () => {
  const repoInit = new Set(environmentKeys(serviceBlock(read(DOKPLOY), 'repo-init')));
  const scripts = read('deploy/dokploy/init.sh') + read('deploy/dokploy/render-config.sh');
  const read_ = new Set(
    [...scripts.matchAll(/\b(GUARD_(?:APP|AGENT|SANDBOX|THRESHOLDS)_[A-Z_]+|GIT(?:HUB|LAB)_[A-Z_]+)\b/g)].map((m) => m[1]),
  );
  assert.ok(read_.size >= 16, 'the scan finds the variables');
  assert.deepEqual([...read_].filter((name) => !repoInit.has(name)).sort(), []);
});

test('the server image ships the scripts and keeps its entry point', () => {
  const dockerfile = read('deploy/Dockerfile');
  const server = dockerfile.slice(dockerfile.indexOf(' AS server'), dockerfile.indexOf(' AS runner'));
  const copy = /^COPY --chmod=0755 (.+) \/usr\/local\/lib\/guard-deploy\/$/m.exec(server)?.[1] ?? '';
  assert.deepEqual(copy.split(' ').sort(), SCRIPTS.map((name) => `deploy/dokploy/${name}`).sort());
  assert.match(read('deploy/Dockerfile.dockerignore'), /^!deploy\/dokploy\/\*\.sh$/m);
  for (const name of SCRIPTS) assert.match(read(`deploy/dokploy/${name}`), /^#!\/bin\/sh\n/, name);
  // The two-file stack starts the image with its own entry point, as before.
  assert.match(server, /^ENTRYPOINT \["guard"\]\nCMD \["serve", "--repo", "\/repo"\]$/m);
  assert.match(server, /^USER guard$/m);
  // The runner target does not get the scripts.
  assert.doesNotMatch(dockerfile.slice(dockerfile.indexOf(' AS runner')), /guard-deploy/);

  const compose = read(DOKPLOY);
  assert.match(serviceBlock(compose, 'repo-init'), /^ {4}entrypoint: \["\/usr\/local\/lib\/guard-deploy\/init\.sh"\]$/m);
  const guard = serviceBlock(compose, 'guard');
  assert.match(guard, /^ {4}entrypoint: \["\/usr\/local\/lib\/guard-deploy\/start\.sh"\]\n {4}command: \["serve", "--repo", "\/repo"\]$/m);
  for (const service of ['volume-init', 'repo-init', 'guard']) {
    assert.match(
      serviceBlock(compose, service),
      /^ {4}build:\n {6}context: \.\.\n {6}dockerfile: deploy\/Dockerfile\n {6}target: server$/m,
      `${service} builds the server target`,
    );
  }
});

test('DOKPLOY.md names what can never come from the environment', () => {
  const doc = read('deploy/DOKPLOY.md');
  const section = doc.slice(doc.indexOf('## What cannot come from the environment'), doc.indexOf('## Variables'));
  for (const item of ['`target.toml`', '`[areas]`', '`[tracker]`', '`[code_host]`', 'journeys catalog', '`DOCKER_GID`', 'sandbox image digest']) {
    assert.ok(section.includes(item), `${item} is listed`);
  }
  assert.ok(doc.includes('deploy/docker-compose.dokploy.yml'));
  assert.ok(doc.includes('deploy/env.dokploy.example'));
  assert.match(doc, /docker\.sock/);
});

test('every variable without a default is named in DOKPLOY.md', () => {
  const doc = read('deploy/DOKPLOY.md');
  const required = [...read(DOKPLOY).matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1]);
  const fromScripts = ['GUARD_AGENT_MODEL', 'GUARD_AGENT_BUDGET_USD', 'GUARD_AGENT_DAILY_USD_CAP', 'GUARD_SANDBOX_IMAGE', 'GUARD_THRESHOLDS_MODE'];
  for (const name of new Set([...required, ...fromScripts])) assert.ok(doc.includes(`\`${name}\``), `${name} is documented`);
});
