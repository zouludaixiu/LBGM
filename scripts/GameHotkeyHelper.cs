using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static class GameHotkeyHelper
{
    private const int VkControl = 0x11;
    private const int VkShift = 0x10;

    private sealed class Binding
    {
        public int Key;
        public bool Control;
        public bool Shift;
        public bool WasDown;
    }

    private static int Main(string[] args)
    {
        // parent PID, event file, ready file, slot 1, slot 2, slot 3, pause, restart
        if (args.Length < 7) return 2;
        int parentPid;
        if (!int.TryParse(args[0], out parentPid)) return 3;
        string eventFile = args[1];
        string readyFile = args[2];
        var play = new[] { ParseBinding(args[3]), ParseBinding(args[4]), ParseBinding(args[5]) };
        Binding pause = ParseBinding(args[6]);
        Binding restart = ParseBinding(args.Length > 7 ? args[7] : "Ctrl+4");
        if (pause == null || restart == null || Array.Exists(play, item => item == null)) return 4;

        Directory.CreateDirectory(Path.GetDirectoryName(eventFile));
        File.WriteAllText(readyFile, "ready");

        while (ParentIsAlive(parentPid))
        {
            for (int slot = 0; slot < play.Length; slot++)
            {
                bool down = IsBindingDown(play[slot]);
                if (down && !play[slot].WasDown) WriteEvent(eventFile, "play", slot);
                play[slot].WasDown = down;
            }

            bool pauseDown = IsBindingDown(pause);
            if (pauseDown && !pause.WasDown) WriteEvent(eventFile, "pause", -1);
            pause.WasDown = pauseDown;
            bool restartDown = IsBindingDown(restart);
            if (restartDown && !restart.WasDown) WriteEvent(eventFile, "restart", -1);
            restart.WasDown = restartDown;
            Thread.Sleep(15);
        }
        return 0;
    }

    private static bool ParentIsAlive(int pid)
    {
        try { return !Process.GetProcessById(pid).HasExited; }
        catch { return false; }
    }

    private static bool IsDown(int key)
    {
        return (GetAsyncKeyState(key) & 0x8000) != 0;
    }

    private static bool IsBindingDown(Binding binding)
    {
        if (binding.Control && !IsDown(VkControl)) return false;
        if (binding.Shift && !IsDown(VkShift)) return false;
        return IsDown(binding.Key);
    }

    private static Binding ParseBinding(string accelerator)
    {
        var result = new Binding();
        var parts = accelerator.ToUpperInvariant().Split('+');
        foreach (string raw in parts)
        {
            string part = raw.Trim();
            if (part == "CTRL" || part == "CONTROL") result.Control = true;
            else if (part == "SHIFT") result.Shift = true;
            else result.Key = ParseKey(part);
        }
        return result.Key == 0 ? null : result;
    }

    private static int ParseKey(string key)
    {
        if (key.Length == 1 && key[0] >= 'A' && key[0] <= 'Z') return key[0];
        if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return key[0];
        if (key.StartsWith("F"))
        {
            int number;
            if (int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24) return 0x6F + number;
        }
        return 0;
    }

    private static void WriteEvent(string eventFile, string type, int slot)
    {
        try
        {
            string json = "{\"id\":\"" + Guid.NewGuid().ToString("N") + "\",\"type\":\"" + type + "\",\"slot\":" + slot + ",\"triggeredAt\":\"" + DateTime.UtcNow.ToString("o") + "\"}";
            File.WriteAllText(eventFile, json);
        }
        catch { }
    }

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
}
