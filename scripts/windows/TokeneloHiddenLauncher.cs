// Per-user GUI-subsystem host. The daemon is created without a console, suspended
// until it belongs to our kill-on-close job. No shell, desktop switch or elevation.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class TokeneloHiddenLauncher
{
    [StructLayout(LayoutKind.Sequential)] private struct Security {
        public int size; public IntPtr descriptor; public int inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct Startup {
        public int size; public string reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort show, reservedBytes; public IntPtr reservedData, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo {
        public IntPtr process, thread; public uint pid, threadId;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
        public long userTime, jobTime; public uint flags; public UIntPtr minSet, maxSet;
        public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters {
        public ulong reads, writes, other, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, int bytes);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern IntPtr CreateFile(string path, uint access, uint sharing, ref Security security, uint disposition, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo process);

    private static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    private static string Quote(string value) {
        // Windows argv quoting; no command interpreter ever receives this text.
        StringBuilder text=new StringBuilder("\""); int slashes=0;
        foreach(char ch in value) {
            if(ch=='\\') { slashes++; continue; }
            if(ch=='\"') { text.Append('\\',slashes*2+1); text.Append(ch); }
            else { text.Append('\\',slashes); text.Append(ch); }
            slashes=0;
        }
        text.Append('\\',slashes*2); return text.Append('"').ToString();
    }
    private static string LogsDirectory() {
        string home=Environment.GetEnvironmentVariable("TOKENELO_HOME");
        return !String.IsNullOrEmpty(home) ? Path.Combine(Path.GetFullPath(home),"logs")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Tokenelo","logs");
    }
    private static IntPtr OpenLog(string path, ref Security security) {
        if(File.Exists(path) && new FileInfo(path).Length>5L*1024*1024) {
            if(File.Exists(path+".1")) File.Delete(path+".1");
            File.Move(path,path+".1");
        }
        // FILE_APPEND_DATA + OPEN_ALWAYS: existing logs append rather than CREATE_NEW failure.
        IntPtr handle=CreateFile(path,4,3,ref security,4,128,IntPtr.Zero);
        Check(handle!=new IntPtr(-1),"open daemon log"); return handle;
    }
    [STAThread] private static int Main(string[] args) {
        IntPtr job=IntPtr.Zero, input=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero;
        ProcessInfo child=new ProcessInfo(); bool childStarted=false, childExited=false;
        string logs=null; int exit=1;
        string role=Path.GetFileNameWithoutExtension(typeof(TokeneloHiddenLauncher).Assembly.Location).EndsWith("-tray-launcher",StringComparison.OrdinalIgnoreCase) ? "tray" : "daemon";
        try {
            bool packagedTray = role=="tray" && args.Length>=2 && args[1]=="--tokenelo-packaged-app";
            if(args.Length!=2 && args.Length!=3)
                throw new ArgumentException("Expected an executable, entry file and optional Tokenelo home, or the packaged tray marker.");
            if(args.Length==3) {
                if(!Path.IsPathRooted(args[2])) throw new ArgumentException("Tokenelo home must be absolute.");
                Environment.SetEnvironmentVariable("TOKENELO_HOME",Path.GetFullPath(args[2]));
            }
            if(role=="tray") Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE",null);
            logs=LogsDirectory(); Directory.CreateDirectory(logs);
            string node=Path.GetFullPath(args[0]);
            if(!File.Exists(node)) throw new FileNotFoundException("The configured runtime executable does not exist.");
            string appRoot=Path.Combine(Path.GetDirectoryName(node),"resources","app");
            bool packagedElectron=Path.GetFileName(node).Equals("Tokenelo.exe",StringComparison.OrdinalIgnoreCase)
                && File.Exists(Path.Combine(appRoot,"package.json"));
            string entry=null;
            if(packagedTray) {
                if(!packagedElectron || !File.Exists(Path.Combine(appRoot,"dist","tray","main.js")))
                    throw new FileNotFoundException("The packaged tray main entrypoint does not exist beside Tokenelo.exe.");
            } else {
                entry=Path.GetFullPath(args[1]);
                if(!File.Exists(entry)) throw new FileNotFoundException("The configured application entry file does not exist.");
                if(packagedElectron) {
                    string expectedEntry=Path.GetFullPath(Path.Combine(appRoot,"dist","daemon","main.js"));
                    if(role!="daemon" || !entry.Equals(expectedEntry,StringComparison.OrdinalIgnoreCase))
                        throw new ArgumentException("Packaged Electron accepts only the packaged daemon entry in Node mode.");
                    // Electron only acts as Node for this owned daemon child; the task's tray
                    // role always starts the packaged application with its package main.
                    Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE","1");
                }
            }
            string childCommand=packagedTray ? Quote(node) : Quote(node)+" "+Quote(entry);
            string workingDirectory=packagedTray ? Path.GetDirectoryName(node)
                : Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(entry)));
            if(String.IsNullOrEmpty(workingDirectory)) throw new ArgumentException("Could not determine the child working directory.");
            Security security=new Security { size=Marshal.SizeOf(typeof(Security)),inherit=1 };
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create owned daemon job");
            ExtendedLimits limits=new ExtendedLimits(); limits.basic.flags=0x2000;
            Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimits))),"set kill-on-owner-exit");
            input=CreateFile("NUL",0x80000000,3,ref security,3,128,IntPtr.Zero);
            Check(input!=new IntPtr(-1),"open daemon input");
            output=OpenLog(Path.Combine(logs,role+".stdout.log"),ref security);
            error=OpenLog(Path.Combine(logs,role+".stderr.log"),ref security);
            Startup startup=new Startup { size=Marshal.SizeOf(typeof(Startup)),flags=0x100|1,show=0,input=input,output=output,error=error };
            // CREATE_NO_WINDOW | CREATE_SUSPENDED. Retain ordinary OS priority inheritance.
            Check(CreateProcess(node,new StringBuilder(childCommand),IntPtr.Zero,IntPtr.Zero,true,0x08000000|4,IntPtr.Zero,workingDirectory,ref startup,out child),"create hidden daemon");
            childStarted=true;
            foreach(IntPtr handle in new IntPtr[] {input,output,error}) Check(SetHandleInformation(handle,1,0),"clear parent stream inheritance");
            Check(AssignProcessToJobObject(job,child.process),"assign suspended daemon to owned job");
            Check(ResumeThread(child.thread)!=0xffffffff,"resume owned daemon");
            Check(WaitForSingleObject(child.process,0xffffffff)==0,"wait for owned daemon");
            uint code; Check(GetExitCodeProcess(child.process,out code),"read daemon exit");
            childExited=true; exit=unchecked((int)code);
            File.WriteAllText(Path.Combine(logs,role+".last-exit.json"),"{\"recordedAt\":\""+DateTime.UtcNow.ToString("o")+"\",\"pid\":"+child.pid+",\"exitCode\":"+code+"}\n",new UTF8Encoding(false));
        } catch(Exception problem) {
            if(logs!=null) try { File.AppendAllText(Path.Combine(logs,role+".launcher.stderr.log"),DateTime.UtcNow.ToString("o")+" "+problem.GetType().Name+": "+problem.Message+"\n",new UTF8Encoding(false)); } catch { }
        } finally {
            // A failure after creation still targets our exact owned process handle, even if job assignment failed.
            if(childStarted&&!childExited) { TerminateProcess(child.process,1); WaitForSingleObject(child.process,5000); }
            if(job!=IntPtr.Zero) CloseHandle(job); // also retires any surviving owned descendants
            foreach(IntPtr handle in new IntPtr[] {child.thread,child.process,input,output,error})
                if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1)) CloseHandle(handle);
        }
        return exit;
    }
}
