import fs from 'node:fs';

export function linuxReportUnitArgs(unit: string, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string[] {
  if (!/^tokenelo-report-[a-f0-9]{32}\.service$/.test(unit)) throw new Error('invalid report unit');
  // Locale/timezone must exist before Node initializes. Clear the manager's
  // Electron mode, then restore only the exact Node-run sentinel when requested.
  // Other daemon environment values cross private stdin after ownership, rather
  // than becoming CLI arguments.
  const electronRunAsNode = env.ELECTRON_RUN_AS_NODE === '1';
  const locale = Object.entries(env).filter(([name, value]) => value !== undefined
    && /^(TZ|LANG|LANGUAGE|LC_(ALL|COLLATE|CTYPE|MESSAGES|MONETARY|NUMERIC|TIME))$/.test(name));
  const localeNames = ['TZ', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME'];
  const result = ['--user', '--quiet', '--pipe', '--wait', '--collect', '--slice=app.slice', `--unit=${unit}`, '--service-type=exec',
    '--property=KillMode=control-group', '--property=SendSIGKILL=yes', '--property=TimeoutStopSec=1s',
    '--property=Restart=no', `--working-directory=${cwd}`, '/usr/bin/env', '-u', 'NODE_OPTIONS', '-u', 'NODE_PATH',
    '-u', 'ELECTRON_RUN_AS_NODE',
    ...localeNames.flatMap(name => ['-u', name]), ...locale.map(([name, value]) => `${name}=${value}`),
    ...(electronRunAsNode ? ['ELECTRON_RUN_AS_NODE=1'] : []),
    `TOKENELO_REPORT_UNIT=${unit}`, '/bin/sh', '-c', 'exec "$@"', '--', executable, ...args];
  // ExecStart expansion otherwise interprets dollars in literal paths/arguments.
  // $$ is systemd's literal dollar escape (no shell is involved).
  const command = result.indexOf('/usr/bin/env');
  return result.map((arg, index) => index >= command ? arg.replace(/\$/g, () => '$$') : arg);
}

export function linuxProcessBirth(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

/** Handles belong to a verified, unique cgroup kernel object. Never kill by a
 * sampled PID, a path reopened after exit, or a possibly reused service name.
 * This contains inherited descendants; it is not a hostile migration sandbox. */
export class LinuxReportCgroup {
  private directory = -1;
  private events = -1;
  private kill = -1;
  constructor(frame: { pid: number; birth: string; cgroup: string }, unit: string) {
    if (!Number.isSafeInteger(frame.pid) || frame.pid <= 0 || !/^\d+$/.test(frame.birth)
      || frame.cgroup !== `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`) throw new Error('unowned report cgroup');
    const membership = () => fs.readFileSync(`/proc/${frame.pid}/cgroup`, 'utf8').trim();
    const expected = `0::${frame.cgroup}`;
    if (membership() !== expected || linuxProcessBirth(frame.pid) !== frame.birth) throw new Error('report identity changed');
    const root = `/sys/fs/cgroup${frame.cgroup}`;
    try {
      this.directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      this.events = fs.openSync(`${root}/cgroup.events`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      this.kill = fs.openSync(`${root}/cgroup.kill`, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      if (fs.fstatSync(this.directory).ino !== fs.statSync(root).ino
        || membership() !== expected || linuxProcessBirth(frame.pid) !== frame.birth) throw new Error('report cgroup changed');
    } catch (error) { this.close(); throw error; }
  }
  terminate(): void {
    try { fs.writeSync(this.kill, Buffer.from('1'), 0, 1, null); }
    catch (error) {
      // A removed retained cgroup cannot contain work. Cancellation during the
      // systemd-run close race must not turn successful cleanup into a read error.
      if ((error as NodeJS.ErrnoException).code !== 'ENODEV') throw error;
    }
  }
  empty(): boolean {
    const data = Buffer.alloc(256);
    try { return /(?:^|\n)populated 0(?:\n|$)/.test(data.subarray(0, fs.readSync(this.events, data, 0, data.length, 0)).toString()); }
    catch (error) {
      // ENODEV on the retained kernfs file proves this exact cgroup was removed.
      // A missing name/path alone is never a retirement receipt.
      if ((error as NodeJS.ErrnoException).code === 'ENODEV') return true;
      throw error;
    }
  }
  close(): void {
    for (const fd of [this.kill, this.events, this.directory]) if (fd >= 0) fs.closeSync(fd);
    this.kill = this.events = this.directory = -1;
  }
}
