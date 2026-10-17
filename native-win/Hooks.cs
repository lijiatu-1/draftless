// 钩子和状态：听热键、听写中截住 esc 和悬浮条按钮上的点击。
// 这一层对应原版的同一个功能。
//
// 钩子必须装在跑消息循环的那个线程上，所以主线程只读标准输入，三件事全在这个线程里：
// 钩子过程 → 判状态 → 一条一行 JSON 报出去。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace Draftless
{
    /// <summary>一个修饰键：认哪几个虚拟键码（左右两边都认，按错边不该被判成"热键没反应"）</summary>
    internal struct Hotkey
    {
        public int[] KeyCodes;
    }

    /// <summary>悬浮条上要截住的一块</summary>
    internal struct Region
    {
        public string Id;
        public int X;
        public int Y;
        public int Width;
        public int Height;

        public bool Contains(int x, int y)
        {
            return x >= X && x < X + Width && y >= Y && y < Y + Height;
        }
    }

    internal sealed class Hooks
    {
        /// <summary>可选的热键。名字和设置里的一致（src/storage/settings.mjs 的 HOTKEY_IDS）</summary>
        public static readonly Dictionary<string, Hotkey> Hotkeys =
            new Dictionary<string, Hotkey>(StringComparer.Ordinal)
            {
                // 第一个是"它自己那一个"，后面是另一边。原版只认右边，Windows 上左右 Alt
                // 在绝大多数程序里就是同一个键，按错边不该没反应
                { "right_alt", new Hotkey { KeyCodes = new[] { Win32.VK_RMENU, Win32.VK_LMENU } } },
                { "right_ctrl", new Hotkey { KeyCodes = new[] { Win32.VK_RCONTROL, Win32.VK_LCONTROL } } },
                { "right_shift", new Hotkey { KeyCodes = new[] { Win32.VK_RSHIFT, Win32.VK_LSHIFT } } },
                { "right_win", new Hotkey { KeyCodes = new[] { Win32.VK_RWIN, Win32.VK_LWIN } } },
            };

        /// <summary>旧名字（原版的）也认，省得从别处抄来的设置写一半崩掉</summary>
        public static readonly Dictionary<string, string> Aliases = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "right_option", "right_alt" },
            { "right_command", "right_win" },
            { "right_control", "right_ctrl" },
            { "fn", "right_shift" },
        };

        /// <summary>一次录音最长 9 分钟。过了这么久还没人说不截了，多半是父进程出了岔子</summary>
        private const int DefaultCaptureLimitSeconds = 600;

        private readonly Hotkey hotkey;
        private readonly int captureLimitSeconds;

        /// <summary>钩子过程和读标准输入那个线程都会动它，用一把锁；抢锁的那一下很短</summary>
        private readonly object regionGate = new object();
        private Region[] regions = new Region[0];
        private bool capturing;
        private bool escapeIsDown;
        private string pressedRegion;
        private Timer captureDeadline;

        private bool hotkeyIsDown;
        private bool reportedOtherKey;

        private IntPtr keyboardHook = IntPtr.Zero;
        private IntPtr mouseHook = IntPtr.Zero;
        private uint threadId;

        /// <summary>钩子装好了、ready 已经报出去了。主线程据此决定什么时候开始接命令</summary>
        private readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);

        /// <summary>钩子过程要能被服务回收，不能是临时委托</summary>
        private readonly Win32.HookProc keyboardProc;
        private readonly Win32.HookProc mouseProc;

        public Hooks(string hotkeyName, int captureLimit)
        {
            hotkey = Hotkeys[hotkeyName];
            captureLimitSeconds = captureLimit > 0 ? captureLimit : DefaultCaptureLimitSeconds;
            keyboardProc = KeyboardProc;
            mouseProc = MouseProc;
        }

        public bool Ready
        {
            get { return ready.Wait(0); }
        }

        public bool WaitUntilReady(int milliseconds)
        {
            return ready.Wait(milliseconds);
        }

        /// <summary>起钩子线程。之后要等 Ready</summary>
        public void Start()
        {
            var thread = new Thread(Run) { IsBackground = true, Name = "draftless-hooks" };
            thread.Start();
        }

        /// <summary>让钩子线程退出消息循环、把钩子卸掉</summary>
        public void Stop()
        {
            if (threadId != 0) Win32.PostThreadMessage(threadId, Win32.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        }

        private void Run()
        {
            threadId = Win32.GetCurrentThreadId();
            IntPtr module = Win32.GetModuleHandle(null);
            keyboardHook = Win32.SetWindowsHookEx(Win32.WH_KEYBOARD_LL, keyboardProc, module, 0);
            mouseHook = Win32.SetWindowsHookEx(Win32.WH_MOUSE_LL, mouseProc, module, 0);
            bool listen = keyboardHook != IntPtr.Zero;
            bool captureReady = mouseHook != IntPtr.Zero;
            Protocol.Ready(listen, captureReady);
            ready.Set();

            Win32.MSG message;
            while (Win32.GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
            {
                Win32.TranslateMessage(ref message);
                Win32.DispatchMessage(ref message);
            }

            if (keyboardHook != IntPtr.Zero) Win32.UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) Win32.UnhookWindowsHookEx(mouseHook);
        }

        // ---- 热键 ----

        private bool IsHotkeyKey(int vkCode)
        {
            foreach (int code in hotkey.KeyCodes)
            {
                if (code == vkCode) return true;
            }
            return false;
        }

        /// <summary>
        /// 和原版逐条对齐：热键按下松开各报一次、只在状态真的变化时报；按住时又按别的键报一次
        /// other_key（组合键，不是听写）；esc 不算别的键；每次热键状态变化清掉"已经报过"的标记。
        /// </summary>
        public void HandleKey(int vkCode, bool down)
        {
            if (IsHotkeyKey(vkCode))
            {
                if (down == hotkeyIsDown) return;
                hotkeyIsDown = down;
                reportedOtherKey = false;
                Protocol.Hotkey(down);
                return;
            }
            if (down && vkCode != Win32.VK_ESCAPE && hotkeyIsDown && !reportedOtherKey)
            {
                reportedOtherKey = true;
                Protocol.OtherKey();
            }
        }

        // ---- 钩子过程 ----

        private IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
            int message = (int)wParam;
            Win32.KBDLLHOOKSTRUCT data = (Win32.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Win32.KBDLLHOOKSTRUCT));
            bool down = message == Win32.WM_KEYDOWN || message == Win32.WM_SYSKEYDOWN;
            int vkCode = (int)data.vkCode;
            HandleKey(vkCode, down);

            // 听写中吞掉 esc：按下、长按的重复、以及那一下的松开都要吞。
            // 只吞按下不吞松开的话，前台应用会收到没头没尾的半个事件
            if (IsCapturing() && vkCode == Win32.VK_ESCAPE)
            {
                if (down)
                {
                    if (!IsEscapeDown())
                    {
                        SetEscapeDown(true);
                        Protocol.Escape();
                    }
                }
                else
                {
                    SetEscapeDown(false);
                }
                return (IntPtr)1;
            }
            return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        private IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
            int message = (int)wParam;
            if (message != Win32.WM_MOUSEMOVE && message != Win32.WM_LBUTTONDOWN && message != Win32.WM_LBUTTONUP)
            {
                return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
            }
            if (!IsCapturing()) return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
            Win32.MSLLHOOKSTRUCT data = (Win32.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Win32.MSLLHOOKSTRUCT));
            if (message == Win32.WM_LBUTTONDOWN)
            {
                string hit = RegionAt(data.pt.x, data.pt.y);
                if (hit == null) return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
                lock (regionGate) pressedRegion = hit;
                return (IntPtr)1;
            }
            string pressed;
            lock (regionGate) pressed = pressedRegion;
            if (message == Win32.WM_LBUTTONUP)
            {
                if (pressed == null) return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
                lock (regionGate) pressedRegion = null;
                // 和普通按钮一样：按下和松开在同一块里才算点了它，拖出去再松手是反悔
                if (RegionAt(data.pt.x, data.pt.y) == pressed) Protocol.Click(pressed);
                return (IntPtr)1;
            }
            // 按下之后还拖着：一路吞到松手为止
            if (pressed != null) return (IntPtr)1;
            return Win32.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        // ---- 状态（钩子线程和主线程都会读写，统一用锁）----

        private bool IsCapturing()
        {
            lock (regionGate) return capturing;
        }

        private bool IsEscapeDown()
        {
            lock (regionGate) return escapeIsDown;
        }

        private void SetEscapeDown(bool value)
        {
            lock (regionGate) escapeIsDown = value;
        }

        private string RegionAt(int x, int y)
        {
            lock (regionGate)
            {
                foreach (Region region in regions)
                {
                    if (region.Contains(x, y)) return region.Id;
                }
                return null;
            }
        }

        /// <summary>开始截 / 不截了。null 是不截了</summary>
        public void SetCapture(Region[] wanted)
        {
            lock (regionGate)
            {
                regions = wanted ?? new Region[0];
                capturing = wanted != null;
                if (wanted == null)
                {
                    // 手还没松开的那一下要吞完整：新按的那一半和上一次的松开都由钩子照常收，
                    // 这里只把状态清掉，不让下一次按下被当成"上一次的延续"
                    pressedRegion = null;
                    escapeIsDown = false;
                }
                if (captureDeadline != null)
                {
                    captureDeadline.Dispose();
                    captureDeadline = null;
                }
                if (wanted == null) return;
                // 过了这么久还没人说不截了，多半是父进程那边出了岔子：自己松开，
                // 不能让 esc 在所有应用里一直按不出来
                captureDeadline = new Timer(_ =>
                {
                    if (!IsCapturing()) return;
                    Protocol.Error("截了 " + captureLimitSeconds + " 秒还没人说不截了，自己松开");
                    SetCapture(null);
                });
                captureDeadline.Change(captureLimitSeconds * 1000, Timeout.Infinite);
            }
        }

        /// <summary>只回一份状态，不改任何东西。命令行 doctor 用</summary>
        public void ReportCheck()
        {
            Protocol.Emit("{\"event\":\"check\",\"listen\":" + Json.Bool(keyboardHook != IntPtr.Zero)
                          + ",\"trusted\":true,\"capture\":" + Json.Bool(mouseHook != IntPtr.Zero)
                          + ",\"clipboard_text\":" + Json.Bool(Clipboard.HasText()) + "}");
        }
    }
}
