// 录音时把系统输出静音。
//
// 为什么：扬声器的声音会回灌进麦克风，模型会把你正在听的东西也听进去（逆向笔记 07 / 11 里
// 原版就这么做）。录完要**还原成原来的静音状态**，不是无条件取消静音——用户本来静音着，
// 我们说完话把他的声音打开，那是替他改了设置。
//
// 走 CoreAudio 的 IAudioEndpointVolume（默认渲染设备）。COM 的 vtable 顺序不能错一个，
// 所以下面两个接口只声明到用得着的方法为止，前面的占位方法一个都不能省。
// 语言级别是 C# 5：不能用 ?.、不能用 $""、out 变量要事先声明。

using System;
using System.Runtime.InteropServices;

namespace Draftless
{
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, uint stateMask, [MarshalAs(UnmanagedType.Interface)] out IMMDevice devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr client);
        int UnregisterControlChangeNotify(IntPtr client);
        int GetChannelCount(out int count);
        int SetMasterVolumeLevel(float level, ref Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        int GetMasterVolumeLevel(out float level);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float level);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    internal static class Audio
    {
        private const int ERender = 0;
        private const int EMultimedia = 1;
        private const uint DeviceStateActive = 1;
        private const uint ClsCtxInprocServer = 1;

        /// <summary>默认渲染设备的音量接口。没有音频设备、或者 COM 拿不到时是 null</summary>
        private static IAudioEndpointVolume Endpoint()
        {
            try
            {
                Type enumeratorType = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
                object created = Activator.CreateInstance(enumeratorType);
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)created;
                IMMDevice device;
                if (enumerator.GetDefaultAudioEndpoint(ERender, EMultimedia, out device) != 0) return null;
                Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                object instance;
                if (device.Activate(ref iid, ClsCtxInprocServer, IntPtr.Zero, out instance) != 0) return null;
                return instance as IAudioEndpointVolume;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>现在系统输出是不是静音的。查不到时是 false（当作没静音，别替用户做决定）</summary>
        public static bool IsMuted()
        {
            IAudioEndpointVolume volume = Endpoint();
            if (volume == null) return false;
            bool mute;
            if (volume.GetMute(out mute) != 0) return false;
            return mute;
        }

        /// <summary>设置系统输出静音。没有音频设备时算成功：没东西可静，也不算坏</summary>
        public static bool SetMute(bool mute)
        {
            IAudioEndpointVolume volume = Endpoint();
            if (volume == null) return true;
            Guid empty = Guid.Empty;
            return volume.SetMute(mute, ref empty) == 0;
        }

        /// <summary>录音开始前用户本来就是静音的吗。没在录音时是 null</summary>
        private static bool? wasMutedBeforeRecording;

        /// <summary>录音开始：记住用户原来的静音状态，然后静音</summary>
        public static void MuteForRecording()
        {
            wasMutedBeforeRecording = IsMuted();
            SetMute(true);
        }

        /// <summary>录音结束：还原成用户原来的静音状态。用户本来静音着，我们不该替他打开声音</summary>
        public static void RestoreAfterRecording()
        {
            if (wasMutedBeforeRecording == null) return;
            SetMute(wasMutedBeforeRecording.Value);
            wasMutedBeforeRecording = null;
        }

        /// <summary>
        /// 自检：静音 → 读回 → 还原成原来的状态 → 读回。
        /// 没有音频设备时是 null（这一项不适用，不算失败）；往返对不上是 false。
        /// </summary>
        public static bool? SelfTest()
        {
            IAudioEndpointVolume volume = Endpoint();
            if (volume == null) return null;
            bool original;
            if (volume.GetMute(out original) != 0) return false;
            Guid empty = Guid.Empty;
            if (volume.SetMute(true, ref empty) != 0) return false;
            bool muted;
            if (volume.GetMute(out muted) != 0 || !muted) return false;
            if (volume.SetMute(original, ref empty) != 0) return false;
            bool restored;
            if (volume.GetMute(out restored) != 0 || restored != original) return false;
            return true;
        }
    }
}
