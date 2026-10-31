import { describe, expect, it } from 'vitest';
import {
  MACOS_TOKENELO_LABELS,
  createMacLaunchAgentPolicy,
  escapeMacPlistString,
  serializeMacLaunchAgentPlist,
  classifyMacLaunchAgentOwnership,
  type MacPackagedAppMetadata,
} from '../../src/tray/macos-launch-agent-policy.js';

const bundlePath = '/Applications/Tokenelo.app';

function metadata(overrides: Partial<MacPackagedAppMetadata> = {}): MacPackagedAppMetadata {
  const appRoot = bundlePath + '/Contents/Resources/app';
  return {
    appBundlePath: bundlePath,
    bundleIdentifier: 'com.elostudios.tokenelo',
    bundleExecutable: 'Tokenelo',
    executablePath: bundlePath + '/Contents/MacOS/Tokenelo',
    executablePresent: true,
    executableIsExecutable: true,
    resourcesAppPath: appRoot,
    packageName: 'tokenelo',
    packagePrivate: true,
    packageType: 'module',
    packageMain: 'dist/tray/main.js',
    daemonEntryPath: appRoot + '/dist/daemon/main.js',
    daemonEntryPresent: true,
    trayEntryPath: appRoot + '/dist/tray/main.js',
    trayEntryPresent: true,
    helperPath: appRoot + '/scripts/install-service-macos.sh',
    helperPresent: true,
    ...overrides,
  };
}

function policy(overrides: {
  appMetadata?: MacPackagedAppMetadata;
  userHome?: string;
  tokeneloHome?: string;
} = {}) {
  return createMacLaunchAgentPolicy({
    appMetadata: metadata(),
    userHome: '/Users/example',
    ...overrides,
  });
}

describe('macOS packaged LaunchAgent policy', () => {
  it('binds Tokenelo.app contents, package metadata, and adjacent executable exactly', () => {
    const result = policy();
    expect(result.app).toEqual({
      appBundlePath: bundlePath,
      appRootPath: bundlePath + '/Contents/Resources/app',
      executablePath: bundlePath + '/Contents/MacOS/Tokenelo',
      daemonEntryPath: bundlePath + '/Contents/Resources/app/dist/daemon/main.js',
      trayEntryPath: bundlePath + '/Contents/Resources/app/dist/tray/main.js',
      helperPath: bundlePath + '/Contents/Resources/app/scripts/install-service-macos.sh',
    });
    expect(result.daemon.plistPath).toBe('/Users/example/Library/LaunchAgents/co.eloai.tokenelo.daemon.plist');
    expect(result.tray.plistPath).toBe('/Users/example/Library/LaunchAgents/co.eloai.tokenelo.tray.plist');
    expect(result.daemon.definition.Label).toBe(MACOS_TOKENELO_LABELS.daemon);
    expect(result.tray.definition.Label).toBe(MACOS_TOKENELO_LABELS.tray);
  });

  it('uses Electron-as-Node only for the daemon and leaves the tray on package main', () => {
    const result = policy();
    expect(result.daemon.definition.ProgramArguments).toEqual([
      bundlePath + '/Contents/MacOS/Tokenelo',
      bundlePath + '/Contents/Resources/app/dist/daemon/main.js',
    ]);
    expect(result.daemon.definition.WorkingDirectory).toBe(bundlePath + '/Contents/Resources/app');
    expect(result.daemon.definition.EnvironmentVariables.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(result.tray.definition.ProgramArguments).toEqual([
      '/usr/bin/env',
      '-u',
      'ELECTRON_RUN_AS_NODE',
      bundlePath + '/Contents/MacOS/Tokenelo',
    ]);
    expect(result.tray.definition.EnvironmentVariables).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(result.tray.definition.WorkingDirectory).toBe(bundlePath + '/Contents/Resources/app');
    expect(result.tray.definition).not.toHaveProperty('KeepAlive');
    expect(serializeMacLaunchAgentPlist(result.tray.definition)).toContain('<string>/usr/bin/env</string>');
    expect(serializeMacLaunchAgentPlist(result.tray.definition)).toContain(
      '<key>WorkingDirectory</key>\n    <string>/Applications/Tokenelo.app/Contents/Resources/app</string>',
    );
  });

  it('rejects a working directory outside the matching packaged app root', () => {
    const definition = policy().daemon.definition;
    expect(() => serializeMacLaunchAgentPlist({
      ...definition,
      WorkingDirectory: '/Users/example/checkout',
    })).toThrow(/adjacent packaged Tokenelo runtime/);
  });

  it('preserves an optional absolute TOKENELO_HOME for both agents without inventing a default', () => {
    const unset = policy();
    expect(unset.daemon.definition.EnvironmentVariables).not.toHaveProperty('TOKENELO_HOME');
    expect(unset.tray.definition.EnvironmentVariables).not.toHaveProperty('TOKENELO_HOME');

    const configured = policy({ tokeneloHome: '/Users/example/Library/Application Support/Tokenelo private' });
    expect(configured.daemon.definition.EnvironmentVariables.TOKENELO_HOME)
      .toBe('/Users/example/Library/Application Support/Tokenelo private');
    expect(configured.tray.definition.EnvironmentVariables.TOKENELO_HOME)
      .toBe('/Users/example/Library/Application Support/Tokenelo private');
  });

  it('escapes XML path values and renders a deterministic plist', () => {
    const xmlPolicy = createMacLaunchAgentPolicy({
      appMetadata: metadata({
        appBundlePath: '/Users/example/Apps & Tools/Tokenelo.app',
        executablePath: '/Users/example/Apps & Tools/Tokenelo.app/Contents/MacOS/Tokenelo',
        resourcesAppPath: '/Users/example/Apps & Tools/Tokenelo.app/Contents/Resources/app',
        daemonEntryPath: '/Users/example/Apps & Tools/Tokenelo.app/Contents/Resources/app/dist/daemon/main.js',
        trayEntryPath: '/Users/example/Apps & Tools/Tokenelo.app/Contents/Resources/app/dist/tray/main.js',
        helperPath: '/Users/example/Apps & Tools/Tokenelo.app/Contents/Resources/app/scripts/install-service-macos.sh',
      }),
      userHome: '/Users/example',
    });
    const xml = serializeMacLaunchAgentPlist(xmlPolicy.daemon.definition);
    expect(xml).toContain('/Users/example/Apps &amp; Tools/Tokenelo.app/Contents/MacOS/Tokenelo');
    expect(xml).toContain(
      '<key>WorkingDirectory</key>\n    <string>/Users/example/Apps &amp; Tools/Tokenelo.app/Contents/Resources/app</string>',
    );
    expect(xml).not.toContain('/Users/example/Apps & Tools/Tokenelo.app/Contents/MacOS/Tokenelo');
    expect(escapeMacPlistString('<x & "y">')).toBe('&lt;x &amp; &quot;y&quot;&gt;');
  });

  it('rejects root aliases, relative paths, traversal, controls, and app-data overlap', () => {
    expect(() => createMacLaunchAgentPolicy({ appMetadata: metadata({ appBundlePath: '/Tokenelo.app' }), userHome: '/Users/example' }))
      .toThrow(/normalized absolute POSIX path/);
    expect(() => createMacLaunchAgentPolicy({ appMetadata: metadata({ appBundlePath: 'Applications/Tokenelo.app' }), userHome: '/Users/example' }))
      .toThrow(/normalized absolute POSIX path/);
    expect(() => createMacLaunchAgentPolicy({ appMetadata: metadata({ appBundlePath: '/Applications/Other/../Tokenelo.app' }), userHome: '/Users/example' }))
      .toThrow(/normalized absolute POSIX path/);
    expect(() => createMacLaunchAgentPolicy({ appMetadata: metadata(), userHome: '/Users/example\nInjected' }))
      .toThrow(/XML control characters/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata(),
      userHome: '/Users/example',
      tokeneloHome: bundlePath + '/Contents/Resources/app/data',
    })).toThrow(/overlap the application bundle/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata(),
      userHome: '/Users/example',
      tokeneloHome: '/',
    })).toThrow(/normalized absolute POSIX path/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata(),
      userHome: '/Users/example',
      tokeneloHome: '/Users',
    })).toThrow(/normalized absolute POSIX path/);
    expect(() => escapeMacPlistString('bad\u0000value')).toThrow(/XML control characters/);
    expect(() => escapeMacPlistString('\ud800')).toThrow(/XML 1.0/);
  });

  it('refuses unknown package metadata and layout mismatches', () => {
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: { ...metadata(), npmDependencies: true },
      userHome: '/Users/example',
    })).toThrow(/unknown or missing metadata/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ bundleIdentifier: 'com.other.app' }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ executablePath: bundlePath + '/Contents/MacOS/Elsewhere' }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ executablePresent: false }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ executableIsExecutable: false }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ packagePrivate: false }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ helperPresent: false }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
    expect(() => createMacLaunchAgentPolicy({
      appMetadata: metadata({ trayEntryPath: bundlePath + '/Contents/Resources/app/checkout.js' }),
      userHome: '/Users/example',
    })).toThrow(/private Tokenelo package contract/);
  });

  it('classifies exact package plist/action ownership and refuses legacy or unknown actors', () => {
    const expected = policy().daemon;
    const plistText = serializeMacLaunchAgentPlist(expected.definition);
    const observed = {
      plistPath: expected.plistPath,
      plistText,
      loadedPath: expected.plistPath,
      programArguments: expected.definition.ProgramArguments,
      workingDirectory: expected.definition.WorkingDirectory,
      environmentVariables: expected.definition.EnvironmentVariables,
    };
    expect(classifyMacLaunchAgentOwnership(expected, observed)).toEqual({
      state: 'owned',
      reason: 'exact-plist-and-action-match',
      loaded: true,
    });
    expect(classifyMacLaunchAgentOwnership(expected, null)).toEqual({
      state: 'missing',
      reason: 'no-file-or-loaded-agent',
    });
    expect(classifyMacLaunchAgentOwnership(expected, { ...observed, loadedPath: '/Users/example/checkout/LaunchAgents/daemon.plist' }))
      .toMatchObject({ state: 'foreign', reason: 'loaded-path-mismatch' });
    expect(classifyMacLaunchAgentOwnership(expected, {
      ...observed,
      programArguments: ['/usr/local/bin/node', '/Users/example/checkout/dist/daemon/main.js'],
    })).toMatchObject({ state: 'foreign', reason: 'action-mismatch' });
    expect(classifyMacLaunchAgentOwnership(expected, {
      ...observed,
      plistText: plistText + '\n',
    })).toMatchObject({ state: 'foreign', reason: 'plist-bytes-mismatch' });
    expect(classifyMacLaunchAgentOwnership(expected, {
      ...observed,
      plistPath: '/Users/example/other/daemon.plist',
    })).toMatchObject({ state: 'foreign', reason: 'plist-path-mismatch' });
    expect(classifyMacLaunchAgentOwnership(expected, { ...observed, extra: 'legacy metadata' }))
      .toMatchObject({ state: 'foreign', reason: 'unknown-observation-shape' });
    expect(classifyMacLaunchAgentOwnership(expected, {
      ...observed,
      environmentVariables: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    })).toMatchObject({ state: 'foreign', reason: 'action-mismatch' });
    expect(classifyMacLaunchAgentOwnership(expected, {
      ...observed,
      workingDirectory: '/Users/example/checkout',
    })).toMatchObject({ state: 'foreign', reason: 'action-mismatch' });
  });
});
