// The LiteLLM service of both compose stacks chooses the Anthropic credential
// when its container starts (docs/contracts/tokens.md, "Anthropic
// credential"). The inline entry script is taken out of each compose file and
// run with a stub in place of LiteLLM's own entry point, so no container and
// no provider is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineScript, read, serviceBlock } from './compose-text.mjs';

const STACKS = ['deploy/docker-compose.yml', 'deploy/docker-compose.dokploy.yml'];
const GATEWAY_IMAGE = /^ {4}image: (ghcr\.io\/berriai\/litellm:\S+)$/m;
const DOCKERFILE_FROM = /^ {8}FROM (ghcr\.io\/berriai\/litellm:\S+)$/m;

/** Runs the service's entry script; the stub prints what LiteLLM would see. */
function start(stack, env) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-gateway-'));
  try {
    mkdirSync(join(dir, 'docker'));
    const stub = join(dir, 'docker', 'prod_entrypoint.sh');
    writeFileSync(stub, '#!/bin/sh\nprintf "key=%s args=%s\\n" "${ANTHROPIC_API_KEY:-}" "$*"\n');
    chmodSync(stub, 0o755);
    const script = inlineScript(read(stack), 'litellm', 'entrypoint');
    return spawnSync('/bin/sh', ['-c', script, '--', '--config', '/app/config.yaml'], {
      cwd: dir,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const stack of STACKS) {
  test(`${stack}: an API key alone reaches LiteLLM unchanged`, () => {
    const run = start(stack, { LITELLM_MASTER_KEY: 'm', ANTHROPIC_API_KEY: 'sk-ant-api03-key' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'key=sk-ant-api03-key args=--config /app/config.yaml\n');
  });

  test(`${stack}: the subscription token wins when both credentials are set`, () => {
    const run = start(stack, {
      LITELLM_MASTER_KEY: 'm',
      ANTHROPIC_API_KEY: 'sk-ant-api03-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'key=sk-ant-oat01-token args=--config /app/config.yaml\n');
  });

  test(`${stack}: the subscription token works without an API key`, () => {
    const run = start(stack, { LITELLM_MASTER_KEY: 'm', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'key=sk-ant-oat01-token args=--config /app/config.yaml\n');
  });

  test(`${stack}: an empty subscription token leaves the API key in place`, () => {
    const run = start(stack, {
      LITELLM_MASTER_KEY: 'm',
      ANTHROPIC_API_KEY: 'sk-ant-api03-key',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'key=sk-ant-api03-key args=--config /app/config.yaml\n');
  });

  test(`${stack}: a subscription token without the OAuth prefix stops the start`, () => {
    const run = start(stack, {
      LITELLM_MASTER_KEY: 'm',
      ANTHROPIC_API_KEY: 'sk-ant-api03-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-api03-pasted-in-the-wrong-variable',
    });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '', 'LiteLLM is not started');
    assert.match(run.stderr, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(run.stderr, /pasted-in-the-wrong-variable/, 'the value is not printed');
  });

  test(`${stack}: a missing master key still stops the start`, () => {
    const run = start(stack, { ANTHROPIC_API_KEY: 'sk-ant-api03-key' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /LITELLM_MASTER_KEY/);
  });

  test(`${stack}: the gateway gets both credentials by name and probes health with python3`, () => {
    const gateway = serviceBlock(read(stack), 'litellm');
    assert.match(gateway, /^ {6}ANTHROPIC_API_KEY:\s*$/m);
    assert.match(gateway, /^ {6}CLAUDE_CODE_OAUTH_TOKEN:\s*$/m);
    // The LiteLLM image ships neither wget nor curl.
    const probe = /^ {6}test: (.*)$/m.exec(gateway)?.[1] ?? '';
    assert.match(probe, /^\["CMD", "python3", "-c", "[^"]*\/health\/liveliness[^"]*"\]$/);
  });
}

test('both stacks pin the same LiteLLM release', () => {
  const compose = GATEWAY_IMAGE.exec(serviceBlock(read(STACKS[0]), 'litellm'))?.[1];
  const dokploy = DOCKERFILE_FROM.exec(serviceBlock(read(STACKS[1]), 'litellm'))?.[1];
  assert.ok(compose, 'docker-compose.yml pins the gateway image');
  assert.equal(dokploy, compose);
  assert.match(compose, /:v\d+\.\d+\.\d+-stable$/, 'a release tag, not latest or main');
});

test('the gateway config reads one Anthropic credential variable and holds no secret', () => {
  const config = read('deploy/litellm/config.yaml');
  const keys = [...config.matchAll(/^\s+api_key:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.match(key, /^os\.environ\/[A-Z][A-Z0-9_]*$/, key);
  assert.ok(keys.includes('os.environ/ANTHROPIC_API_KEY'));
  assert.doesNotMatch(config, /^\s+api_key:\s*os\.environ\/CLAUDE_CODE_OAUTH_TOKEN/m);
});

test('no sandbox-facing service receives the subscription token', () => {
  for (const stack of STACKS) {
    const compose = read(stack);
    const holders = compose.split('\n').filter((line) => /^\s+CLAUDE_CODE_OAUTH_TOKEN:/.test(line));
    assert.equal(holders.length, 1, `${stack}: only the gateway holds the token`);
    assert.match(serviceBlock(compose, 'litellm'), /CLAUDE_CODE_OAUTH_TOKEN:/);
  }
});
