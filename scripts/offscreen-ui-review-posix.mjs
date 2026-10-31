#!/usr/bin/env node
/**
 * Task-owned process launcher for the hidden FILED-EXAMPLE Electron review on
 * Linux and macOS. Linux uses a private Xvfb display. macOS uses the review
 * runner's Dock/app hiding guard before any BrowserWindow is created.
 *
 * Required environment: TOKENELO_OFFSCREEN_UI_REVIEW_ALLOWED_ROOT,
 * TOKENELO_OFFSCREEN_UI_REVIEW_APP_ROOT, TOKENELO_OFFSCREEN_UI_REVIEW_ELECTRON,
 * TOKENELO_OFFSCREEN_UI_REVIEW_COHORT, TOKENELO_OFFSCREEN_UI_REVIEW_SOURCE_SHA,
 * and TOKENELO_OFFSCREEN_UI_REVIEW_OUT. The output directory must be a new
 * direct child of the allowed root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertExecutionPaths, assertPrivateOutputRoot } from './offscreen-ui-review-policy.mjs';

const REVIEW_RUNNER = fileURLToPath(new URL('./offscreen-ui-review.mjs', import.meta.url));
const TIMEOUT_MS = 90_000;
const TERM_GRACE_MS = 2_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function sameRealPath(actual, requested) {
  return process.platform === 'win32'
    ? path.resolve(actual).toLowerCase() === path.resolve(requested).toLowerCase()
    : path.resolve(actual) === path.resolve(requested);
}

function processGroupExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    return code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pid, durationMs) {
  const deadline = Date.now() + durationMs;
  while (processGroupExists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return !processGroupExists(pid);
}

function appendBounded(chunks, state, bytes) {
  const remaining = MAX_LOG_BYTES - state.bytes;
  if (remaining <= 0) return;
  const selected = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
  chunks.push(selected);
  state.bytes += selected.length;
}

async function terminateOwnedGroup(pid, signal) {
  if (!processGroupExists(pid)) return true;
  try { process.kill(-pid, signal); }
  catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    if (code !== 'ESRCH') return false;
  }
  return waitForProcessGroupExit(pid, TERM_GRACE_MS);
}

async function run() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('POSIX launcher is supported only on Linux and macOS');
  }

  const allowedRoot = path.resolve(required('TOKENELO_OFFSCREEN_UI_REVIEW_ALLOWED_ROOT'));
  const appRoot = path.resolve(required('TOKENELO_OFFSCREEN_UI_REVIEW_APP_ROOT'));
  const electronPath = path.resolve(required('TOKENELO_OFFSCREEN_UI_REVIEW_ELECTRON'));
  const cohort = required('TOKENELO_OFFSCREEN_UI_REVIEW_COHORT');
  const sourceSha = required('TOKENELO_OFFSCREEN_UI_REVIEW_SOURCE_SHA');
  const outputRoot = path.resolve(required('TOKENELO_OFFSCREEN_UI_REVIEW_OUT'));
  const usageRanges = process.env.TOKENELO_OFFSCREEN_UI_REVIEW_USAGE_RANGES;

  assertExecutionPaths(appRoot, electronPath, { platform: process.platform, allowedRoot });
  assertPrivateOutputRoot(outputRoot, { platform: process.platform, allowedRoot });
  for (const [label, selected] of [['task root', allowedRoot], ['app root', appRoot], ['Electron executable', electronPath]]) {
    const stat = fs.lstatSync(selected);
    if (stat.isSymbolicLink() || !sameRealPath(fs.realpathSync(selected), selected)) {
      throw new Error(`${label} resolves through a symbolic link`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
  }
  const rootStat = fs.lstatSync(allowedRoot);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o002) !== 0) throw new Error('task root must be a real, non-world-writable directory');
  if (fs.existsSync(outputRoot)) throw new Error('output root already exists; refusing to reuse prior evidence');

  const profileRoot = path.join(outputRoot, 'profile');
  const home = path.join(profileRoot, 'home');
  const temporary = path.join(outputRoot, 'temp');
  const cache = path.join(profileRoot, 'cache');
  const config = path.join(profileRoot, 'config');
  for (const directory of [outputRoot, profileRoot, home, temporary, cache, config]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const pathEntries = [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  if (process.platform === 'darwin') pathEntries.push('/opt/homebrew/bin');
  const environment = {
    PATH: pathEntries.join(path.delimiter),
    HOME: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    LANG: process.env.LANG ?? 'C.UTF-8',
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
    TOKENELO_OFFSCREEN_UI_REVIEW_ALLOWED_ROOT: allowedRoot,
    TOKENELO_OFFSCREEN_UI_REVIEW_APP_ROOT: appRoot,
    TOKENELO_OFFSCREEN_UI_REVIEW_ELECTRON: electronPath,
    TOKENELO_OFFSCREEN_UI_REVIEW_COHORT: cohort,
    TOKENELO_OFFSCREEN_UI_REVIEW_SOURCE_SHA: sourceSha,
    TOKENELO_OFFSCREEN_UI_REVIEW_OUT: outputRoot,
    ...(usageRanges ? { TOKENELO_OFFSCREEN_UI_REVIEW_USAGE_RANGES: usageRanges } : {}),
  };

  const runnerCommand = process.platform === 'linux'
    ? path.resolve(process.env.TOKENELO_OFFSCREEN_UI_REVIEW_XVFB_RUN ?? '/usr/bin/xvfb-run')
    : electronPath;
  const runnerArguments = process.platform === 'linux'
    ? ['-a', '--server-args=-screen 0 1024x768x24 -nolisten tcp', electronPath, REVIEW_RUNNER]
    : [REVIEW_RUNNER];
  if (process.platform === 'linux' && !fs.existsSync(runnerCommand)) throw new Error('xvfb-run is unavailable; refusing to use a desktop display');

  const stdoutChunks = [], stderrChunks = [];
  const stdoutState = { bytes: 0 }, stderrState = { bytes: 0 };
  let child;
  let timedOut = false;
  let timeout;
  let spawnError = null;
  const startedAt = new Date().toISOString();
  try {
    child = spawn(runnerCommand, runnerArguments, { cwd: path.dirname(REVIEW_RUNNER).replace(/[/\\]scripts$/, ''),
      env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => appendBounded(stdoutChunks, stdoutState, chunk));
    child.stderr.on('data', chunk => appendBounded(stderrChunks, stderrState, chunk));
    child.on('error', error => { spawnError = error.message; });
    timeout = setTimeout(() => {
      timedOut = true;
      void terminateOwnedGroup(child.pid, 'SIGTERM').then(clean => clean ? undefined : terminateOwnedGroup(child.pid, 'SIGKILL'));
    }, TIMEOUT_MS);
    const closed = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    clearTimeout(timeout);
    let processGroupClean = await waitForProcessGroupExit(child.pid, TERM_GRACE_MS);
    let forcedGroupTermination = false;
    if (!processGroupClean) {
      forcedGroupTermination = true;
      processGroupClean = await terminateOwnedGroup(child.pid, 'SIGTERM');
      if (!processGroupClean) processGroupClean = await terminateOwnedGroup(child.pid, 'SIGKILL');
    }
    fs.writeFileSync(path.join(outputRoot, 'electron.stdout.txt'), Buffer.concat(stdoutChunks), { mode: 0o600 });
    fs.writeFileSync(path.join(outputRoot, 'electron.stderr.txt'), Buffer.concat(stderrChunks), { mode: 0o600 });
    const receiptPath = path.join(outputRoot, 'review-receipt.json');
    const review = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    const reviewClean = review?.status === 'PASS'
      && review?.source?.expectedSourceSha === sourceSha
      && review?.source?.builtSourceSha === sourceSha
      && review?.execution?.visible === false
      && review?.execution?.focused === false
      && review?.execution?.networkFetchCalls === 0
      && review?.execution?.blockedNetworkRequests === 0
      && review?.execution?.unexpectedNavigations === 0
      && review?.execution?.deniedWindowOpens === 0
      && (process.platform !== 'darwin' || review?.execution?.macAppSurfaceHidden === true);
    const status = !timedOut && !forcedGroupTermination && closed.code === 0 && processGroupClean && reviewClean ? 'PASS' : 'FAIL';
    const launchReceipt = {
      schemaVersion: 1,
      status,
      recordedAt: new Date().toISOString(),
      startedAt,
      platform: process.platform,
      architecture: process.arch,
      cohort,
      sourceSha,
      appRoot,
      electronPath,
      runnerPath: REVIEW_RUNNER,
      displayIsolation: process.platform === 'linux' ? runnerCommand : 'offscreen BrowserWindow plus hidden macOS Dock/app surface',
      childPid: child.pid ?? null,
      childExitCode: closed.code,
      childSignal: closed.signal,
      timedOut,
      forcedGroupTermination,
      processGroupClean,
      stdoutBytes: stdoutState.bytes,
      stderrBytes: stderrState.bytes,
      spawnError,
      reviewStatus: review?.status ?? null,
      reviewedStates: Array.isArray(review?.states) ? review.states.length : 0,
      macAppSurfaceHidden: process.platform === 'darwin' ? review?.execution?.macAppSurfaceHidden === true : null,
    };
    fs.writeFileSync(path.join(outputRoot, 'launch-receipt.json'), `${JSON.stringify(launchReceipt, null, 2)}\n`, { mode: 0o600 });
    if (status !== 'PASS') process.exitCode = 1;
    process.stdout.write(JSON.stringify({ status, cohort, platform: process.platform, states: launchReceipt.reviewedStates,
      childExitCode: launchReceipt.childExitCode, processGroupClean, macAppSurfaceHidden: launchReceipt.macAppSurfaceHidden }) + '\n');
  } catch (error) {
    clearTimeout(timeout);
    if (child?.pid) await terminateOwnedGroup(child.pid, 'SIGTERM');
    process.stderr.write(`${error instanceof Error ? error.message : 'unknown POSIX UI launch error'}\n`);
    process.exitCode = 1;
  }
}

await run();
