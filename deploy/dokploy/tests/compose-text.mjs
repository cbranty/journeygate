// Plain-text helpers for the compose files, shared by the tests in this
// folder. Dependency-free on purpose (no YAML parser), like ci/tests: they
// rely on the two-space layout the compose files in deploy/ use.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

/** The lines of `services.<name>`, without the `  <name>:` line itself. */
export function serviceBlock(compose, name) {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const rest = lines.slice(start + 1);
  // The block ends at the next line indented by two spaces or less.
  const end = rest.findIndex((line) => /^ {0,2}[^\s#]/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Every service name under the top-level `services:` key. */
export function serviceNames(compose) {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === 'services:');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[^\s#]/.test(line));
  return (end < 0 ? rest : rest.slice(0, end))
    .map((line) => /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line)?.[1])
    .filter(Boolean);
}

/**
 * The `- |` block scalar under `<key>:` of a service, dedented and with
 * Compose's `$$` escape undone: the shell script the container runs.
 */
export function inlineScript(compose, service, key) {
  const lines = serviceBlock(compose, service).split('\n');
  const at = lines.findIndex((line) => line === `    ${key}:`);
  if (at < 0) throw new Error(`service ${service} has no block-style ${key}`);
  const marker = lines.findIndex((line, i) => i > at && /^ {6}- \|$/.test(line));
  if (marker < 0) throw new Error(`service ${service} ${key} has no "- |" script`);
  const body = [];
  for (const line of lines.slice(marker + 1)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break;
    body.push(line.slice(8));
  }
  return body.join('\n').replaceAll('$$', '$');
}

/** Every variable a compose file interpolates: `${NAME}`, `${NAME:-x}`, `${NAME:?x}`. */
export function interpolatedVariables(compose) {
  // `$${NAME}` is an escaped dollar for the container's shell, not interpolation.
  const names = [...compose.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

/** Variables passed through by name only: `      NAME:` under `environment:`. */
export function passThroughVariables(compose) {
  const names = [...compose.matchAll(/^ {6}([A-Z][A-Z0-9_]*):\s*$/gm)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

/** The variable names an env template declares (`NAME=`). */
export function templateVariables(template) {
  return [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]).sort();
}
