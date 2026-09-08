import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import type { FsPolicy } from '../src/adapters/cli/fs-policy.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const linux = process.platform === 'linux';
const hasBwrap = linux && spawnSync('bwrap', ['--version']).status === 0;
const canRunBwrap = hasBwrap && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc',
  '--', '/bin/true',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;

function fixture(layout: 'home-link' | 'data-link' | 'canonical') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-sandbox-data-')));
  const home = join(root, 'home');
  const dataDir = join(home, '.botmux/data');
  const ownStore = join(dataDir, 'session-stores/app-a');
  const ownBotHome = join(home, '.botmux/bots/app-a');
  const workspace = join(root, 'workspace');
  const origin = join(dataDir, 'read-isolation/origin-own');
  const attestation = join(dataDir, 'read-isolation/attest-own');
  for (const path of [ownStore, ownBotHome, workspace, origin, attestation]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(ownStore, 'sessions.db'), 'own-session');
  writeFileSync(join(origin, 'capability.json'), 'own-capability');
  writeFileSync(join(attestation, 'proof.json'), 'own-proof');
  const siblingStore = join(dataDir, 'session-stores/app-b');
  const siblingOrigin = join(dataDir, 'read-isolation/origin-other');
  for (const path of [siblingStore, siblingOrigin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(siblingStore, 'sessions.db'), 'private-sibling');
  writeFileSync(join(siblingOrigin, 'capability.json'), 'private-sibling');
  const alias = join(root, 'alias');
  symlinkSync(layout === 'home-link' ? home : dataDir, alias);
  const configuredDataDir = layout === 'home-link'
    ? join(alias, '.botmux/data')
    : layout === 'data-link' ? alias : dataDir;
  const policy: FsPolicy = {
    rules: [
      ...['/usr', '/etc', ownStore, origin, attestation].map(path => ({
        path, access: 'readOnly' as const, source: 'internal' as const,
      })),
      ...[workspace, ownBotHome].map(path => ({
        path, access: 'readWrite' as const, source: 'internal' as const,
      })),
    ],
    net: true,
    writeRegexes: [],
  };
  return { root, home, dataDir, configuredDataDir, ownBotHome, workspace, policy };
}

function cleanup(f: ReturnType<typeof fixture>, plan: ReturnType<typeof prepareDirectSandbox>) {
  // Bun's recursive rm does not repair mode-000 directories like Node does.
  // Restore only this fixture's empty mask, after the sandbox child has exited.
  const empty = join(f.dataDir, 'sandboxes/session/empty');
  if (existsSync(empty)) chmodSync(empty, 0o700);
  plan?.cleanup();
  rmSync(f.root, { recursive: true, force: true });
}

describe.skipIf(!hasBwrap)('sandbox session-data root', () => {
  it.each(['home-link', 'data-link', 'canonical'] as const)(
    'pins the mounted root in both the child env and bwrap argv (%s)', layout => {
      const f = fixture(layout);
      let plan: ReturnType<typeof prepareDirectSandbox> = null;
      try {
        plan = prepareDirectSandbox({
          sessionId: 'session', dataDir: f.configuredDataDir, policy: f.policy,
          chdir: f.workspace, home: f.home, cliBin: '/bin/true', cliArgs: [],
        });
        expect(plan).not.toBeNull();
        expect(plan!.env.SESSION_DATA_DIR).toBe(f.dataDir);
        const keyAt = plan!.args.indexOf('SESSION_DATA_DIR');
        expect(plan!.args.slice(keyAt - 1, keyAt + 2)).toEqual([
          '--setenv', 'SESSION_DATA_DIR', f.dataDir,
        ]);
      } finally {
        cleanup(f, plan);
      }
    },
  );

  it.skipIf(!canRunBwrap)('resolves session state through a symlinked home without exposing siblings', () => {
    const f = fixture('home-link');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.configuredDataDir, policy: f.policy,
        chdir: f.workspace, home: f.home, cliBin: '/bin/sh', cliArgs: ['-ec', `
          cat "$SESSION_DATA_DIR/session-stores/app-a/sessions.db"
          cat "$SESSION_DATA_DIR/read-isolation/origin-own/capability.json"
          cat "$SESSION_DATA_DIR/read-isolation/attest-own/proof.json"
          test ! -r "$SESSION_DATA_DIR/session-stores/app-b/sessions.db"
          test ! -r "$SESSION_DATA_DIR/read-isolation/origin-other/capability.json"
          printf schedule > "$SESSION_DATA_DIR/../bots/app-a/schedule-probe"
        `],
      });
      expect(plan).not.toBeNull();
      const result = spawnSync(plan!.bin, plan!.args, {
        env: { ...process.env, SESSION_DATA_DIR: f.configuredDataDir },
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('own-sessionown-capabilityown-proof');
      expect(readFileSync(join(f.ownBotHome, 'schedule-probe'), 'utf8')).toBe('schedule');
    } finally {
      cleanup(f, plan);
    }
  });

  it.skipIf(!canRunBwrap)('creates a schedule for the inferred session inside the real sandbox', () => {
    const f = fixture('home-link');
    let plan: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      rmSync(join(f.dataDir, 'session-stores/app-a/sessions.db'));
      seedPersistedSessionRows(f.dataDir, 'app-a', {
        session: {
          sessionId: 'session', chatId: 'oc_own', rootMessageId: 'om_own',
          title: 'own session', status: 'active', createdAt: new Date(0).toISOString(),
          larkAppId: 'app-a', cliId: 'codex', workingDir: f.workspace,
          ownerOpenId: 'ou_owner', chatType: 'p2p', scope: 'chat',
        },
      });
      const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
      const { command, prefixArgs } = tsRunnerPrefix();
      f.policy.rules.push(...[repoRoot, dirname(realpathSync(command))].map(path => ({
        path, access: 'readOnly' as const, source: 'internal' as const,
      })));
      plan = prepareDirectSandbox({
        sessionId: 'session', dataDir: f.configuredDataDir, policy: f.policy,
        chdir: repoRoot, home: f.home, cliBin: command,
        cliArgs: [...prefixArgs, join(repoRoot, 'src/cli.ts'),
          'schedule', 'add', '0 12 * * *', 'fixture reminder'],
      });
      expect(plan).not.toBeNull();
      const result = spawnSync(plan!.bin, plan!.args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          SESSION_DATA_DIR: f.configuredDataDir,
          BOTMUX_SESSION_ID: 'session', BOTMUX_LARK_APP_ID: 'app-a',
          BOTMUX_API_ONLY: '0', BOTMUX_READ_ISOLATION: '1',
          BOTMUX_WORKFLOW: '',
        },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('已创建定时任务');
      const store = JSON.parse(readFileSync(join(f.ownBotHome, 'schedules.json'), 'utf8'));
      expect(Object.values(store)).toEqual([expect.objectContaining({
        chatId: 'oc_own', larkAppId: 'app-a', ownerOpenId: 'ou_owner',
        workingDir: f.workspace, prompt: 'fixture reminder',
      })]);
    } finally {
      cleanup(f, plan);
    }
  });
});
