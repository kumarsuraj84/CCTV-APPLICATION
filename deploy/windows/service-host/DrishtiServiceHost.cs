// CityKart Drishti service host (P5.4). A small Windows service wrapper: Node.js and go2rtc do not speak the Service Control Manager's
// protocol, so sc.exe cannot run them directly. This host is what sc.exe registers; it runs ONE program (node.exe with the web app,
// the worker or the gateway; go2rtc.exe), and:
//   - sets the program's environment from the service's own env file (KEY=VALUE lines; values are never logged),
//   - writes the program's output to <logdir>\<name>.log, rolled at logmaxbytes, logkeep files kept,
//   - restarts the program when it ends by itself (5 s, doubling to 60 s; back to 5 s after 10 minutes of running),
//   - on stop, sends Ctrl+C (the programs stop cleanly: the worker hands its lease back, the gateway closes its sockets), waits
//     stoptimeoutsec, then ends the program and everything it started (a Job Object: no ffmpeg is ever left behind),
//   - ends the program with itself if the host is killed (the Job Object closes with the host).
// It needs no installation: deploy/windows/drishti-services.ps1 compiles it with the C# compiler of the .NET Framework 4 that every
// Windows 10/11 has (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe). C# 5 only (that compiler's language level).
//
//   DrishtiServiceHost.exe <file.conf>            as a service (sc.exe binPath)
//   DrishtiServiceHost.exe --console <file.conf>  without the Service Control Manager, for a test; a file <logdir>\stop.request stops
//                                                 it the same way a service stop does
//
// The .conf file: name=, exe=, arg= (repeatable, in order), workdir=, envfile=, logdir=, logmaxbytes=, logkeep=, stoptimeoutsec=,
// restartdelaysec=, restartmaxdelaysec=. It holds no secret (the env file is named, not copied).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace Drishti
{
    public sealed class HostConfig
    {
        public string Name = "DrishtiService";
        public string Exe;
        public List<string> Args = new List<string>();
        public string WorkDir;
        public string EnvFile;
        public string LogDir;
        public long LogMaxBytes = 10L * 1024 * 1024;
        public int LogKeep = 10;
        public int StopTimeoutSec = 20;
        public int RestartDelaySec = 5;
        public int RestartMaxDelaySec = 60;

        public static HostConfig Load(string path)
        {
            HostConfig c = new HostConfig();
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) throw new InvalidDataException("Not a key=value line in " + path + ": " + line);
                string k = line.Substring(0, eq).Trim().ToLowerInvariant();
                string v = line.Substring(eq + 1).Trim();
                switch (k)
                {
                    case "name": c.Name = v; break;
                    case "exe": c.Exe = v; break;
                    case "arg": c.Args.Add(v); break;
                    case "workdir": c.WorkDir = v; break;
                    case "envfile": c.EnvFile = v; break;
                    case "logdir": c.LogDir = v; break;
                    case "logmaxbytes": c.LogMaxBytes = long.Parse(v); break;
                    case "logkeep": c.LogKeep = int.Parse(v); break;
                    case "stoptimeoutsec": c.StopTimeoutSec = int.Parse(v); break;
                    case "restartdelaysec": c.RestartDelaySec = int.Parse(v); break;
                    case "restartmaxdelaysec": c.RestartMaxDelaySec = int.Parse(v); break;
                    default: throw new InvalidDataException("Unknown key '" + k + "' in " + path);
                }
            }
            if (string.IsNullOrEmpty(c.Exe)) throw new InvalidDataException("exe= is missing in " + path);
            if (string.IsNullOrEmpty(c.LogDir)) throw new InvalidDataException("logdir= is missing in " + path);
            if (c.LogKeep < 1) c.LogKeep = 1;
            if (c.LogMaxBytes < 65536) c.LogMaxBytes = 65536;
            return c;
        }

        /// <summary>KEY=VALUE lines; # comments and blank lines skipped; one pair of surrounding quotes removed.</summary>
        public static Dictionary<string, string> ReadEnvFile(string path)
        {
            Dictionary<string, string> env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(path)) return env;
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string k = line.Substring(0, eq).Trim();
                string v = line.Substring(eq + 1).Trim();
                if (v.Length >= 2 && ((v[0] == '"' && v[v.Length - 1] == '"') || (v[0] == '\'' && v[v.Length - 1] == '\''))) v = v.Substring(1, v.Length - 2);
                env[k] = v;
            }
            return env;
        }
    }

    /// <summary>One log file per service, rolled by size: name.log, name.1.log ... name.(keep-1).log.</summary>
    public sealed class RollingLog
    {
        private readonly object gate = new object();
        private readonly string dir;
        private readonly string name;
        private readonly long maxBytes;
        private readonly int keep;
        private StreamWriter writer;

        public RollingLog(string dir, string name, long maxBytes, int keep)
        {
            this.dir = dir; this.name = name; this.maxBytes = maxBytes; this.keep = keep;
            Directory.CreateDirectory(dir);
            Open();
        }

        private string PathOf(int i) { return Path.Combine(dir, i == 0 ? name + ".log" : name + "." + i + ".log"); }

        private void Open()
        {
            writer = new StreamWriter(new FileStream(PathOf(0), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false));
            writer.AutoFlush = true;
        }

        public void Write(string line)
        {
            lock (gate)
            {
                try
                {
                    writer.WriteLine(line);
                    if (writer.BaseStream.Length >= maxBytes) Roll();
                }
                catch (IOException) { }
            }
        }

        public void Host(string message)
        {
            Write("{\"level\":\"info\",\"time\":\"" + DateTime.UtcNow.ToString("o") + "\",\"event\":\"service_host\",\"service\":\"" + name + "\",\"message\":\"" + message.Replace("\\", "\\\\").Replace("\"", "'") + "\"}");
        }

        private void Roll()
        {
            writer.Dispose();
            string oldest = PathOf(keep - 1);
            if (keep > 1 && File.Exists(oldest)) File.Delete(oldest);
            for (int i = keep - 2; i >= 0; i--)
            {
                if (keep == 1) break;
                string from = PathOf(i);
                if (File.Exists(from)) File.Move(from, PathOf(i + 1));
            }
            if (keep == 1 && File.Exists(PathOf(0))) File.Delete(PathOf(0));
            Open();
        }

        public void Close() { lock (gate) { try { writer.Dispose(); } catch (IOException) { } } }
    }

    internal static class Native
    {
        public delegate bool ConsoleCtrlDelegate(uint ctrlType);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AllocConsole();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
        [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handler, bool add);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
            public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
        }
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint CTRL_C_EVENT = 0;
    }

    /// <summary>Runs the program, restarts it when it ends by itself, stops it cleanly on request.</summary>
    public sealed class Supervisor
    {
        private readonly HostConfig cfg;
        private readonly RollingLog log;
        private readonly ManualResetEvent stopRequested = new ManualResetEvent(false);
        private readonly object gate = new object();
        private Process child;
        private IntPtr job = IntPtr.Zero;
        private Thread thread;
        private static Native.ConsoleCtrlDelegate swallow; // kept so the delegate is never collected

        public Supervisor(HostConfig cfg)
        {
            this.cfg = cfg;
            log = new RollingLog(cfg.LogDir, cfg.Name, cfg.LogMaxBytes, cfg.LogKeep);
        }

        public void Start()
        {
            // A private, hidden console that only the host and its program share, so that the Ctrl+C sent on stop reaches the program
            // and nothing else (a console the host was started from is left first: its other programs must never get that Ctrl+C).
            // The host itself swallows Ctrl+C with a handler (not the "ignore" flag, which a new program would inherit).
            Native.FreeConsole();
            if (Native.AllocConsole())
            {
                IntPtr w = Native.GetConsoleWindow();
                if (w != IntPtr.Zero) Native.ShowWindow(w, 0);
            }
            // Clear an inherited "ignore Ctrl+C" flag (a parent started with a new process group passes it on): the program must get it.
            Native.SetConsoleCtrlHandler(null, false);
            swallow = delegate (uint type) { return true; };
            Native.SetConsoleCtrlHandler(swallow, true);
            job = Native.CreateJobObject(IntPtr.Zero, null);
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Start();
        }

        private static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return a;
            StringBuilder sb = new StringBuilder("\"");
            int slashes = 0;
            foreach (char ch in a)
            {
                if (ch == '\\') { slashes++; continue; }
                if (ch == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); slashes = 0; continue; }
                sb.Append('\\', slashes); slashes = 0; sb.Append(ch);
            }
            sb.Append('\\', slashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        private Process Launch()
        {
            ProcessStartInfo psi = new ProcessStartInfo(cfg.Exe);
            List<string> quoted = new List<string>();
            foreach (string a in cfg.Args) quoted.Add(Quote(a));
            psi.Arguments = string.Join(" ", quoted.ToArray());
            psi.WorkingDirectory = string.IsNullOrEmpty(cfg.WorkDir) ? Path.GetDirectoryName(cfg.Exe) : cfg.WorkDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = false; // share the host's (hidden) console: Ctrl+C reaches the program
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            Dictionary<string, string> env = HostConfig.ReadEnvFile(cfg.EnvFile);
            foreach (KeyValuePair<string, string> kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
            Process p = new Process();
            p.StartInfo = psi;
            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) log.Write(e.Data); };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) log.Write(e.Data); };
            p.Start();
            if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, p.Handle);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            log.Host("started " + Path.GetFileName(cfg.Exe) + " (process " + p.Id + ", " + env.Count + " settings from the env file)");
            return p;
        }

        private void Loop()
        {
            int delay = cfg.RestartDelaySec;
            while (!stopRequested.WaitOne(0))
            {
                DateTime startedAt = DateTime.UtcNow;
                Process p;
                try { p = Launch(); }
                catch (Exception e)
                {
                    log.Host("could not start: " + e.Message);
                    if (stopRequested.WaitOne(TimeSpan.FromSeconds(delay))) break;
                    delay = Math.Min(delay * 2, cfg.RestartMaxDelaySec);
                    continue;
                }
                lock (gate) { child = p; }
                p.WaitForExit();
                int code = p.ExitCode;
                lock (gate) { child = null; }
                if (stopRequested.WaitOne(0)) { log.Host("stopped (exit code " + code + ")"); break; }
                if ((DateTime.UtcNow - startedAt).TotalMinutes >= 10) delay = cfg.RestartDelaySec;
                log.Host("ended by itself (exit code " + code + "); starting again in " + delay + " s");
                if (stopRequested.WaitOne(TimeSpan.FromSeconds(delay))) break;
                delay = Math.Min(delay * 2, cfg.RestartMaxDelaySec);
            }
        }

        /// <summary>Ctrl+C, wait, then end the program and everything it started. Returns true when it stopped cleanly.</summary>
        public bool Stop()
        {
            stopRequested.Set();
            Process p;
            lock (gate) { p = child; }
            bool clean = true;
            if (p != null && !p.HasExited)
            {
                log.Host("stop requested: Ctrl+C sent, waiting up to " + cfg.StopTimeoutSec + " s");
                Native.GenerateConsoleCtrlEvent(Native.CTRL_C_EVENT, 0);
                if (!p.WaitForExit(cfg.StopTimeoutSec * 1000))
                {
                    clean = false;
                    log.Host("did not stop in time: ended");
                }
            }
            if (job != IntPtr.Zero) Native.TerminateJobObject(job, 1);
            if (thread != null) thread.Join(5000);
            log.Close();
            return clean;
        }

        public int StopTimeoutSec { get { return cfg.StopTimeoutSec; } }
    }

    public sealed class HostService : ServiceBase
    {
        private readonly HostConfig cfg;
        private Supervisor sup;

        public HostService(HostConfig cfg)
        {
            this.cfg = cfg;
            ServiceName = cfg.Name;
            CanStop = true;
            CanShutdown = true;
        }

        protected override void OnStart(string[] args)
        {
            sup = new Supervisor(cfg);
            sup.Start();
        }

        protected override void OnStop()
        {
            RequestAdditionalTime((sup.StopTimeoutSec + 15) * 1000);
            sup.Stop();
        }

        protected override void OnShutdown() { OnStop(); }
    }

    public static class Program
    {
        public static int Main(string[] args)
        {
            bool console = args.Length == 2 && args[0] == "--console";
            if (args.Length != 1 && !console)
            {
                Console.Error.WriteLine("Usage: DrishtiServiceHost.exe [--console] <file.conf>");
                return 2;
            }
            HostConfig cfg;
            try { cfg = HostConfig.Load(console ? args[1] : args[0]); }
            catch (Exception e)
            {
                Console.Error.WriteLine("The service host configuration could not be read: " + e.Message);
                return 3;
            }
            if (!console)
            {
                ServiceBase.Run(new HostService(cfg));
                return 0;
            }
            // Console mode (tests): the host moves to its own hidden console, so it is stopped by a file "<logdir>\stop.request"
            // instead of Ctrl+C; the stop itself is the same as a service stop.
            Supervisor sup = new Supervisor(cfg);
            sup.Start();
            string stopFile = Path.Combine(cfg.LogDir, "stop.request");
            while (!File.Exists(stopFile)) Thread.Sleep(250);
            File.Delete(stopFile);
            bool clean = sup.Stop();
            return clean ? 0 : 1;
        }
    }
}
