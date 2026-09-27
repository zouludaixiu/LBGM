using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class AudioRouteWatchdog
{
    private const string RemoteDll = @"C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll";

    private static int Main(string[] args)
    {
        if (args.Length < 2) return 2;
        int parentPid;
        float gainDb;
        if (!int.TryParse(args[0], out parentPid)) return 3;
        if (!float.TryParse(args[1], NumberStyles.Float, CultureInfo.InvariantCulture, out gainDb)) return 4;
        string statusPath = args.Length >= 3 ? args[2] : null;
        gainDb = Math.Max(-3f, Math.Min(12f, gainDb));
        string gainText = gainDb.ToString("0.0", CultureInfo.InvariantCulture);
        string command = "Strip[0].A1=0;Strip[0].B1=1;Strip[0].Gain=" + gainText + ";";

        while (ParentIsAlive(parentPid))
        {
            int login = -999;
            int readBefore = -999;
            int setResult = -999;
            int readAfter = -999;
            float before = float.NaN;
            float after = float.NaN;
            try
            {
                login = VBVMR_Login();
                if (login >= 0)
                {
                    VBVMR_IsParametersDirty();
                    readBefore = VBVMR_GetParameterFloat("Strip[0].Gain", out before);
                    bool needsRepair = readBefore != 0 || Math.Abs(before - gainDb) > 0.05f;
                    if (needsRepair)
                    {
                        setResult = VBVMR_SetParametersW(command);
                        Thread.Sleep(600);
                        // The Remote API can report a cached value in the same
                        // login. Reconnect before verifying the engine value.
                        VBVMR_Logout();
                        Thread.Sleep(250);
                        login = VBVMR_Login();
                    }
                    else
                    {
                        setResult = 0;
                    }
                    if (login >= 0)
                    {
                        VBVMR_IsParametersDirty();
                        readAfter = VBVMR_GetParameterFloat("Strip[0].Gain", out after);
                        WriteStatus(statusPath, gainDb, before, after, login, readBefore, setResult, readAfter, needsRepair, null);
                        VBVMR_Logout();
                    }
                    else WriteStatus(statusPath, gainDb, before, after, login, readBefore, setResult, readAfter, needsRepair, "verification login failed");
                }
                else WriteStatus(statusPath, gainDb, before, after, login, readBefore, setResult, readAfter, false, "login failed");
            }
            catch (Exception error)
            {
                try { VBVMR_Logout(); } catch { }
                WriteStatus(statusPath, gainDb, before, after, login, readBefore, setResult, readAfter, false, error.Message);
            }

            for (int i = 0; i < 12 && ParentIsAlive(parentPid); i++)
                Thread.Sleep(250);
        }
        return 0;
    }

    private static void WriteStatus(string path, float desired, float before, float after, int login, int readBefore, int setResult, int readAfter, bool repaired, string error)
    {
        if (String.IsNullOrEmpty(path)) return;
        try
        {
            string beforeText = float.IsNaN(before) ? "null" : before.ToString("0.0", CultureInfo.InvariantCulture);
            string afterText = float.IsNaN(after) ? "null" : after.ToString("0.0", CultureInfo.InvariantCulture);
            string escapedError = error == null ? "" : error.Replace("\\", "\\\\").Replace("\"", "\\\"");
            string json = "{\n" +
                "  \"checkedAt\": \"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\",\n" +
                "  \"desiredGainDb\": " + desired.ToString("0.0", CultureInfo.InvariantCulture) + ",\n" +
                "  \"beforeGainDb\": " + beforeText + ",\n" +
                "  \"afterGainDb\": " + afterText + ",\n" +
                "  \"repaired\": " + (repaired ? "true" : "false") + ",\n" +
                "  \"loginResult\": " + login + ",\n" +
                "  \"readBeforeResult\": " + readBefore + ",\n" +
                "  \"setResult\": " + setResult + ",\n" +
                "  \"readAfterResult\": " + readAfter + ",\n" +
                "  \"error\": \"" + escapedError + "\"\n" +
                "}\n";
            File.WriteAllText(path, json);
        }
        catch { }
    }

    private static bool ParentIsAlive(int pid)
    {
        try { return !Process.GetProcessById(pid).HasExited; }
        catch { return false; }
    }

    [DllImport(RemoteDll)] private static extern int VBVMR_Login();
    [DllImport(RemoteDll)] private static extern int VBVMR_Logout();
    [DllImport(RemoteDll)] private static extern int VBVMR_IsParametersDirty();
    [DllImport(RemoteDll, CharSet = CharSet.Ansi)] private static extern int VBVMR_GetParameterFloat(string name, out float value);
    [DllImport(RemoteDll, CharSet = CharSet.Unicode)] private static extern int VBVMR_SetParametersW(string script);
}
