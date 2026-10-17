// Win32 的声明和常量。集中在一个文件里，别的文件只认这里的名字，查 MSDN 时对得上。
// 目标是最小可用的 .NET Framework（csc.exe 4.0 就能编），所以不用 Span、不用 System.Text.Json。

using System;
using System.Runtime.InteropServices;

namespace Draftless
{
    internal static class Win32
    {
        // ---- 钩子 ----

        public const int WH_KEYBOARD_LL = 13;
        public const int WH_MOUSE_LL = 14;

        // ---- 窗口消息 ----

        public const int WM_KEYDOWN = 0x0100;
        public const int WM_KEYUP = 0x0101;
        public const int WM_SYSKEYDOWN = 0x0104;
        public const int WM_SYSKEYUP = 0x0105;
        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_QUIT = 0x0012;

        // ---- 虚拟键码 ----

        public const int VK_ESCAPE = 0x1b;
        public const int VK_CONTROL = 0x11;
        public const int VK_MENU = 0x12;
        public const int VK_SHIFT = 0x10;
        public const int VK_LSHIFT = 0xa0;
        public const int VK_RSHIFT = 0xa1;
        public const int VK_LCONTROL = 0xa2;
        public const int VK_RCONTROL = 0xa3;
        public const int VK_LMENU = 0xa4;
        public const int VK_RMENU = 0xa5;
        public const int VK_LWIN = 0x5b;
        public const int VK_RWIN = 0x5c;
        public const int VK_V = 0x56;

        /// <summary>F24：没有程序会绑它，用来空跑一次 SendInput 看返回几（自检里那一道闸）</summary>
        public const int VK_F24 = 0x87;

        // ---- 发按键 ----

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_KEYUP = 0x02;

        // ---- 剪贴板 ----

        public const uint CF_TEXT = 1;
        public const uint CF_BITMAP = 2; // GDI 句柄，不是 HGLOBAL，快照时跳过
        public const uint CF_UNICODETEXT = 13;
        public const uint GMEM_MOVEABLE = 0x0002;

        // ---- 结构体 ----

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int ptX;
            public int ptY;
            public uint lPrivate;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        /// <summary>
        /// INPUT 在 C 里是个联合体。x64 上最大的是 MOUSEINPUT（32 字节），加上 type 和补齐一共 **40**。
        ///
        /// 这里显式指定大小和对齐，不用"多垫几个 long 凑够"的写法：之前垫了三个 long，
        /// 结构体变成 56 字节，而 SendInput 会拿 cbSize 跟它自己认的 40 比，不匹配就一个键都不发、
        /// 直接返回 0（GetLastError 87）。表现出来就是"文字生成了但贴不进光标"，
        /// 而且一路被误当成权限问题（UI 上还提示"管理员权限的窗口收不到模拟按键"）。
        /// 实测见过：13:25 和 13:29 两次听写全是 reason: input_blocked。
        ///
        /// 用 Explicit + Size = 40 之后，type 在 0、键盘联合体从 8 开始（KEYBDINPUT 24 字节，到 32），
        /// 剩下 8 字节留白，正好和 C 的 sizeof(INPUT) 对上。
        /// </summary>
        [StructLayout(LayoutKind.Explicit, Size = 40)]
        public struct INPUT
        {
            [FieldOffset(0)]
            public uint type;

            [FieldOffset(8)]
            public KEYBDINPUT ki;
        }

        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        // ---- 函数 ----

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern int GetMessage(out MSG msg, IntPtr hwnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        public static extern bool TranslateMessage(ref MSG msg);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref MSG msg);

        [DllImport("user32.dll")]
        public static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EmptyClipboard();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr GetClipboardData(uint uFormat);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

        [DllImport("user32.dll")]
        public static extern uint EnumClipboardFormats(uint format);

        [DllImport("user32.dll")]
        public static extern int IsClipboardFormatAvailable(uint format);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint RegisterClipboardFormat(string lpszFormat);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalFree(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GlobalLock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GlobalUnlock(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern UIntPtr GlobalSize(IntPtr hMem);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        // ---- 判断前台窗口收不收得到我们发的按键 ----
        //
        // Windows 的 UIPI 按完整性等级拦：低等级的进程发的模拟按键进不了高等级的窗口（典型是
        // "以管理员身份运行"的程序）。表现出来是 SendInput 不报错、但对面毫无反应，
        // 所以要在发之前问一句：对面是不是比我们高。反查文档见 docs/targets/typeless/docs/14-result-delivery.md
        // 的备忘第 1 条（"插入后检查输入框是否可编辑，不可编辑就给复制兜底"）——Windows 上"不可写"的
        // 最常见原因就是这个，先挡住比事后猜好。

        /// <summary>TokenElevation 这个类别：问这个令牌有没有被提权</summary>
        public const int TokenElevation = 20;

        public const uint TOKEN_QUERY = 0x0008;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(
            IntPtr TokenHandle,
            int TokenInformationClass,
            out uint TokenInformation,
            uint TokenInformationLength,
            out uint ReturnLength);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    }
}
