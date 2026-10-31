// Windows report-process containment. Compile as a GUI subsystem executable: no console.
// The parent sends framed stdin or a nonce-bound stop command. The helper owns the job
// handle; children are assigned atomically at creation and cannot break away. Retirement
// is reported only after the job's actual ActiveProcesses count is zero and pipes close.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ReportJobHost {
  const uint KillOnClose = 0x2000, NoWindow = 0x08000000, ExtendedStartup = 0x00080000;
  const uint UseStdHandles = 0x100, HandleInherit = 1;
  static readonly object OutputLock = new object();
  static readonly object StopLock = new object();
  static Stream output;
  static IntPtr job;
  static string nonce;
  static int stopped;
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public int Size; public IntPtr Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public ushort Show,ReservedSize; public IntPtr ReservedBytes,In,Out,Err;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User,Kernel,PeriodUser,PeriodKernel; public uint PageFaults,TotalProcesses,ActiveProcesses,TerminatedProcesses;
  }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security,string name);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int type,ref ExtendedLimits limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int type,out Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr h,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security security,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string cwd,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static Stream Standard(int kind,FileAccess access) {
    IntPtr h=GetStdHandle(kind); if(h==IntPtr.Zero||h==new IntPtr(-1))throw new IOException("missing redirected stream");
    return new FileStream(new SafeFileHandle(h,false),access,4096,false);
  }
  static string Quote(string value) {
    if(value==null||value.IndexOf('\0')>=0)throw new ArgumentException("invalid argument");
    StringBuilder s=new StringBuilder("\"");int slashes=0;
    foreach(char c in value) {
      if(c=='\\'){slashes++;continue;}
      if(c=='\"')s.Append('\\',slashes*2+1);else s.Append('\\',slashes);
      s.Append(c);slashes=0;
    }
    return s.Append('\\',slashes*2).Append('"').ToString();
  }
  static void Frame(string json) {
    byte[] b=Encoding.UTF8.GetBytes(json+"\n");lock(OutputLock){output.Write(b,0,b.Length);output.Flush();}
  }
  static void Stop() {
    lock(StopLock){if(stopped==1)return;Check(TerminateJobObject(job,137));stopped=1;}
  }
  static Thread CopyPipe(IntPtr handle,string channel) {
    Thread t=new Thread(delegate() {
      try { using(Stream input=new FileStream(new SafeFileHandle(handle,false),FileAccess.Read,16384,false)) {
        byte[] buffer=new byte[16384];int count;
        while((count=input.Read(buffer,0,buffer.Length))>0)Frame("{\"channel\":\""+channel+"\",\"base64\":\""+Convert.ToBase64String(buffer,0,count)+"\"}");
      }}catch { try{Stop();}catch{} }
    });t.IsBackground=true;t.Start();return t;
  }
  static bool ValidNonce(string value) {
    if(value==null||value.Length!=32)return false;
    foreach(char c in value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))return false;
    return true;
  }
  // A failed helper cannot supply its final receipt. The parent can inspect the exact
  // nonce-named job after that helper exits. No PID enumeration or process termination.
  // FILE_NOT_FOUND means the job was destroyed; Windows destroys it after its last
  // handle is closed and all associated processes terminate (KILL_ON_JOB_CLOSE).
  static int Observe(string token) {
    if(!ValidNonce(token))throw new ArgumentException("invalid nonce");
    IntPtr observed=OpenJobObject(4,false,"Local\\Tokenelo.Report."+token);
    if(observed==IntPtr.Zero) {
      int error=Marshal.GetLastWin32Error();if(error!=2)throw new Win32Exception(error);
      Frame("{\"channel\":\"host\",\"event\":\"job_absent\",\"nonce\":\""+token+"\"}");return 0;
    }
    try {
      Accounting accounting;do{Check(QueryInformationJobObject(observed,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));if(accounting.ActiveProcesses>0)Thread.Sleep(10);}while(accounting.ActiveProcesses>0);
      Frame("{\"channel\":\"host\",\"event\":\"job_zero\",\"activeProcesses\":0,\"nonce\":\""+token+"\"}");return 0;
    }finally{CloseHandle(observed);}
  }
  static int Main(string[] args) {
    List<IntPtr> handles=new List<IntPtr>();IntPtr attributes=IntPtr.Zero,values=IntPtr.Zero;ProcessInfo process=new ProcessInfo();bool processCreated=false;
    try {
      output=Standard(-11,FileAccess.Write);
      if(args.Length==2&&args[0]=="observe")return Observe(args[1]);
      if(args.Length!=3||!ValidNonce(args[2]))throw new ArgumentException("invalid invocation");
      nonce=args[2];string exe=Path.GetFullPath(args[0]);if(!File.Exists(exe))throw new ArgumentException("missing executable");
      string[] childArgs=new JavaScriptSerializer().Deserialize<string[]>(Encoding.UTF8.GetString(Convert.FromBase64String(args[1])));
      if(childArgs==null)throw new ArgumentException("missing arguments");
      StringBuilder command=new StringBuilder(Quote(exe));foreach(string arg in childArgs)command.Append(' ').Append(Quote(arg));
      if(command.Length>32766)throw new ArgumentException("command too long");
      job=CreateJobObject(IntPtr.Zero,"Local\\Tokenelo.Report."+nonce);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      // A collision never grants ownership of an existing job.
      if(Marshal.GetLastWin32Error()==183){CloseHandle(job);job=IntPtr.Zero;throw new IOException("job identity already exists");}
      ExtendedLimits limits=new ExtendedLimits();limits.Basic.Flags=KillOnClose;Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      Security security=new Security();security.Size=Marshal.SizeOf(typeof(Security));security.Inherit=1;
      IntPtr stdinRead,stdinWrite,stdoutRead,stdoutWrite,stderrRead,stderrWrite;
      Check(CreatePipe(out stdinRead,out stdinWrite,ref security,0));handles.Add(stdinRead);handles.Add(stdinWrite);
      Check(CreatePipe(out stdoutRead,out stdoutWrite,ref security,0));handles.Add(stdoutRead);handles.Add(stdoutWrite);
      Check(CreatePipe(out stderrRead,out stderrWrite,ref security,0));handles.Add(stderrRead);handles.Add(stderrWrite);
      Check(SetHandleInformation(stdinWrite,HandleInherit,0));Check(SetHandleInformation(stdoutRead,HandleInherit,0));Check(SetHandleInformation(stderrRead,HandleInherit,0));
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      if(size==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      attributes=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributes,2,0,ref size));
      values=Marshal.AllocHGlobal(IntPtr.Size*4);Marshal.WriteIntPtr(values,0,stdinRead);Marshal.WriteIntPtr(values,IntPtr.Size,stdoutWrite);Marshal.WriteIntPtr(values,IntPtr.Size*2,stderrWrite);Marshal.WriteIntPtr(values,IntPtr.Size*3,job);
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),values,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      // JOB_LIST assigns at creation, eliminating the suspended-but-unassigned crash window.
      Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000d),IntPtr.Add(values,IntPtr.Size*3),new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      StartupEx startup=new StartupEx();startup.Startup.Size=Marshal.SizeOf(typeof(StartupEx));startup.Startup.Flags=UseStdHandles;startup.Startup.In=stdinRead;startup.Startup.Out=stdoutWrite;startup.Startup.Err=stderrWrite;startup.Attributes=attributes;
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,NoWindow|ExtendedStartup,IntPtr.Zero,null,ref startup,out process));processCreated=true;
      CloseHandle(stdinRead);handles.Remove(stdinRead);CloseHandle(stdoutWrite);handles.Remove(stdoutWrite);CloseHandle(stderrWrite);handles.Remove(stderrWrite);
      Frame("{\"channel\":\"host\",\"event\":\"started\",\"pid\":"+process.Pid+",\"nonce\":\""+nonce+"\"}");
      Thread outThread=CopyPipe(stdoutRead,"stdout"),errThread=CopyPipe(stderrRead,"stderr");
      BlockingCollection<byte[]> forwarding=new BlockingCollection<byte[]>();
      Thread writer=new Thread(delegate() {
        try {using(Stream childInput=new FileStream(new SafeFileHandle(stdinWrite,false),FileAccess.Write,4096,false)) {
          foreach(byte[] bytes in forwarding.GetConsumingEnumerable()){childInput.Write(bytes,0,bytes.Length);childInput.Flush();}
        }}catch{try{Stop();}catch{}}
      });writer.IsBackground=true;writer.Start();
      Thread control=new Thread(delegate() {
        try {
          using(StreamReader input=new StreamReader(Standard(-10,FileAccess.Read),new UTF8Encoding(false,true),false,4096)) {
            string line;JavaScriptSerializer json=new JavaScriptSerializer();json.MaxJsonLength=12*1024*1024; // Headroom for the parent's shared8MiB raw frame after base64.
            while((line=input.ReadLine())!=null) {
              Dictionary<string,object> packet=json.Deserialize<Dictionary<string,object>>(line);object channel;
              if(packet==null||!packet.TryGetValue("channel",out channel))throw new IOException("invalid control");
              if((string)channel=="stop") {object token;if(!packet.TryGetValue("nonce",out token)||(string)token!=nonce)throw new IOException("invalid owner");Stop();return;}
              if((string)channel!="stdin")throw new IOException("invalid channel");
              // The control reader never waits on the child's pipe; stop/EOF remains
              // actionable even while startup forwarding is blocked on a full pipe.
              forwarding.Add(Convert.FromBase64String((string)packet["base64"]));
            }
          }
          Stop(); // Parent EOF is an owned cancellation; do not leave a report behind.
        }catch {try{Stop();}catch{}}finally{forwarding.CompleteAdding();}
      });control.IsBackground=true;control.Start();
      uint wait;do{wait=WaitForSingleObject(process.Process,50);if(wait==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());}while(wait==0x102);
      uint exit;Check(GetExitCodeProcess(process.Process,out exit));Stop();
      Accounting accounting;do{Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));if(accounting.ActiveProcesses>0)Thread.Sleep(10);}while(accounting.ActiveProcesses>0);
      outThread.Join();errThread.Join();
      Frame("{\"channel\":\"host\",\"event\":\"retired\",\"activeProcesses\":0,\"exitCode\":"+exit+",\"nonce\":\""+nonce+"\"}");return exit==0?0:1;
    }catch(Exception e) {
      // A failed launch with no native process handles cannot leak a child. Bind
      // that distinct receipt to the requested owner; never infer it after creation.
      if(!processCreated&&process.Process==IntPtr.Zero&&process.Thread==IntPtr.Zero&&process.Pid==0&&ValidNonce(nonce)) {
        try{Frame("{\"channel\":\"host\",\"event\":\"not_started\",\"processCreated\":false,\"nonce\":\""+nonce+"\"}");}catch{}
        return 1;
      }
      try{if(output!=null)Frame("{\"channel\":\"host\",\"event\":\"failure\",\"code\":\"containment_unavailable\",\"win32\":"+(e is Win32Exception?((Win32Exception)e).NativeErrorCode:0)+"}");}catch{}
      return 1;
    }finally {
      if(job!=IntPtr.Zero)CloseHandle(job);
      if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);if(process.Process!=IntPtr.Zero)CloseHandle(process.Process);
      if(attributes!=IntPtr.Zero){DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}if(values!=IntPtr.Zero)Marshal.FreeHGlobal(values);
      foreach(IntPtr h in handles)CloseHandle(h);
    }
  }
}
