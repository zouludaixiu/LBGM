using System;
using System.Runtime.InteropServices;

namespace LbgmPersistentAudio
{
    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        int GetMixFormat(); int GetDeviceFormat(); int ResetDeviceFormat(); int SetDeviceFormat();
        int GetProcessingPeriod(); int SetProcessingPeriod(); int GetShareMode(); int SetShareMode();
        int GetPropertyValue(); int SetPropertyValue();
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
        int SetEndpointVisibility();
    }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    class PolicyConfigClient { }

    public static class DefaultDevice
    {
        public static void Set(string id)
        {
            var client = (IPolicyConfig)new PolicyConfigClient();
            for (int role = 0; role < 3; role++)
                Marshal.ThrowExceptionForHR(client.SetDefaultEndpoint(id, role));
        }
    }

    public static class Voicemeeter
    {
        const string RemoteDll = @"C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll";

        [DllImport(RemoteDll)] public static extern int VBVMR_Login();
        [DllImport(RemoteDll)] public static extern int VBVMR_Logout();
        [DllImport(RemoteDll)] public static extern int VBVMR_IsParametersDirty();
        [DllImport(RemoteDll, CharSet = CharSet.Ansi)] public static extern int VBVMR_GetParameterFloat(string name, out float value);
        [DllImport(RemoteDll, CharSet = CharSet.Unicode)] public static extern int VBVMR_SetParametersW(string script);
        [DllImport(RemoteDll, EntryPoint = "VBVMR_SetParameterStringW")]
        public static extern int SetString(
            [MarshalAs(UnmanagedType.LPStr)] string name,
            [MarshalAs(UnmanagedType.LPWStr)] string value);
    }
}
