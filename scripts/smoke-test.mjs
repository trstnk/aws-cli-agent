#!/usr/bin/env node
/**
 * Smoke test for the built CLI. Runs after `npm run build` and verifies the
 * basic command surface without needing any cloud credentials or network.
 * Intentionally minimal — this is a CI guard against shipping a broken
 * binary, not a replacement for proper unit tests.
 *
 * Each check is independent; we collect failures and exit 1 only at the end.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
const distDir = path.resolve(__dirname, '..', 'dist');
const failures = [];

if (!fs.existsSync(cli)) {
  console.error(`FATAL: dist/index.js not found at ${cli}`);
  console.error('Run `npm run build` first.');
  process.exit(2);
}

/** Run the built CLI with an isolated XDG environment, return its result. */
function runCli(args, env = {}) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-smoke-'));
  try {
    return spawnSync('node', [cli, ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdg,
        XDG_STATE_HOME: xdg,
        XDG_DATA_HOME: xdg,
        NO_COLOR: '1',
        ...env,
      },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(xdg, { recursive: true, force: true });
  }
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  await check('--version prints semver', () => {
    const r = runCli(['--version']);
    assert(r.status === 0, `exit ${r.status}, stderr=${r.stderr}`);
    assert(/^\d+\.\d+\.\d+/.test(r.stdout.trim()), `unexpected: ${r.stdout}`);
  });

  await check('--help mentions aca and lists commands', () => {
    const r = runCli(['--help']);
    assert(r.status === 0, `exit ${r.status}`);
    assert(r.stdout.includes('aca'), 'missing "aca" in help output');
    for (const sub of ['config', 'paths', 'history', 'run']) {
      assert(r.stdout.includes(sub), `missing subcommand "${sub}" in help`);
    }
  });

  await check('config command writes a parseable default file', () => {
    // Use a separate XDG dir we manage ourselves so we can inspect the file
    // *after* the CLI exits but *before* cleanup.
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-cfg-'));
    try {
      const r = spawnSync('node', [cli, 'config'], {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdg,
          XDG_STATE_HOME: xdg,
          XDG_DATA_HOME: xdg,
          NO_COLOR: '1',
        },
        encoding: 'utf8',
      });
      assert(r.status === 0, `exit ${r.status}`);
      const configPath = r.stdout.trim();
      assert(fs.existsSync(configPath), `config file not created at ${configPath}`);
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert(parsed.provider === 'anthropic', 'unexpected default provider');
      assert(
        parsed.logging && parsed.logging.level === 'error',
        'unexpected default log level',
      );
      assert(parsed.logging.auditLog === true, 'audit log should default to true');
      assert(parsed.logging.reasoningLog === false, 'reasoning log should default to false');
      assert(parsed.logging.usageLog === true, 'usage log should default to true');
      assert(parsed.caching === true, 'caching should default to true');
    } finally {
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });

  await check('paths command lists all expected files plus script folder', () => {
    const r = runCli(['paths']);
    assert(r.status === 0, `exit ${r.status}`);
    for (const label of [
      'config file',
      'history',
      'general log',
      'audit log',
      'reasoning log',
      'usage log',
      'script folder',
    ]) {
      assert(r.stdout.includes(label), `paths output missing "${label}"`);
    }
  });

  await check('--auto-approve flag is accepted', () => {
    const r = runCli(['--auto-approve', '--help']);
    assert(r.status === 0, `exit ${r.status}, stderr=${r.stderr}`);
  });

  await check('--region flag is accepted', () => {
    const r = runCli(['--region', 'eu-west-1', '--help']);
    assert(r.status === 0, `exit ${r.status}, stderr=${r.stderr}`);
  });

  await check('--interactive / -i flag is accepted', () => {
    const longForm = runCli(['--interactive', '--help']);
    assert(longForm.status === 0, `--interactive: exit ${longForm.status}, stderr=${longForm.stderr}`);
    const shortForm = runCli(['-i', '--help']);
    assert(shortForm.status === 0, `-i: exit ${shortForm.status}, stderr=${shortForm.stderr}`);
  });

  await check('--quiet flag is rejected (removed in 0.3.0)', () => {
    // Don't combine with --help: commander processes --help first and returns 0
    // before validating other options. Pass --quiet alone.
    const r = runCli(['--quiet']);
    assert(r.status !== 0, '--quiet should no longer be a valid flag');
    assert(
      (r.stderr ?? '').includes('--quiet'),
      `expected an error mentioning --quiet, got: ${r.stderr}`,
    );
  });

  await check('prompt_user and prompt_user_multi are registered', async () => {
    // Import the compiled tool factory and verify both prompt tools register.
    // Catches the case where someone refactors prompt.ts but forgets to add
    // the new tool to tools/index.ts.
    const { createTools } = await import(`file://${path.join(distDir, 'tools/index.js')}`);
    const { Logger } = await import(`file://${path.join(distDir, 'logger.js')}`);
    const { AuditLogger } = await import(`file://${path.join(distDir, 'audit.js')}`);
    const tools = createTools({
      logger: new Logger('silent'),
      config: {
        provider: 'anthropic',
        model: 'x',
        maxSteps: 1,
        logging: { level: 'silent', auditLog: false, reasoningLog: false },
        verbose: false,
        autoApprove: { readOnly: true, all: false },
        historyLimit: 0,
      },
      history: { search: () => [], recent: () => [], append: () => {} },
      audit: new AuditLogger(false),
      record: () => {},
    });
    assert('prompt_user' in tools, 'prompt_user missing from tool set');
    assert('prompt_user_multi' in tools, 'prompt_user_multi missing from tool set');
    // Verify each kind is accepted by the schema (sanity that the schema
    // hasn't drifted from what the system prompt promises the model).
    for (const kind of ['text', 'choice', 'confirm', 'secret']) {
      const r = tools.prompt_user.inputSchema.safeParse({
        kind,
        message: 'q',
        ...(kind === 'choice' ? { choices: ['a', 'b'] } : {}),
      });
      assert(r.success, `prompt_user rejected valid kind=${kind}`);
    }
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll smoke checks passed.`);
}

await main();
