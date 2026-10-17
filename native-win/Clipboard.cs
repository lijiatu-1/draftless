// 贴字：存剪贴板 → 换成要贴的文字 → 模拟 Ctrl+V → 把原来的还回去。
//
// 这一层对应原版的同一个功能，只有一处不一样：
// macOS 用 NSPasteboard，一个 item 可以有多种类型、按 item 分组还原；Windows 的剪贴板是一张
// "格式 → 数据"的表，没有分组，所以这里按格式逐个存、逐个还。
// 延迟渲染的格式（拿到句柄是空的，真正的数据等系统来问）存不下来，还原时只能丢掉那一种。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Draftless
{
    internal static class Clipboard
    {
        private const int OpenRetryMilliseconds = 10;
        private const int OpenTimeoutMilliseconds = 1000;

        /// <summary>剪贴板某项的内容。改了之后要能原样写回去</summary>
        public struct Entry
        {
            public uint Format;
            public byte[] Bytes;
        }

        /// <summary>
        /// 打开剪贴板并执行一段操作。一次只能有一个程序打开它，别的程序正开着就等一会儿再试。
        /// </summary>
        public static T WithClipboard<T>(Func<T> action)
        {
            if (!Open()) throw new InvalidOperationException("剪贴板被别的程序占着");
            try
            {
                return action();
            }
            finally
            {
                Win32.CloseClipboard();
            }
        }

        public static void WithClipboard(Action action)
        {
            WithClipboard<int>(() =>
            {
                action();
                return 0;
            });
        }

        private static bool Open()
        {
            int waited = 0;
            while (waited <= OpenTimeoutMilliseconds)
            {
                if (Win32.OpenClipboard(IntPtr.Zero)) return true;
                Thread.Sleep(OpenRetryMilliseconds);
                waited += OpenRetryMilliseconds;
            }
            return false;
        }

        /// <summary>存下剪贴板里所有能读出来的格式</summary>
        public static List<Entry> Snapshot()
        {
            return WithClipboard(() =>
            {
                var saved = new List<Entry>();
                uint format = 0;
                while ((format = Win32.EnumClipboardFormats(format)) != 0)
                {
                    if (format == Win32.CF_BITMAP) continue;
                    byte[] bytes = ReadFormat(format);
                    if (bytes != null) saved.Add(new Entry { Format = format, Bytes = bytes });
                }
                return saved;
            });
        }

        private static byte[] ReadFormat(uint format)
        {
            IntPtr handle = Win32.GetClipboardData(format);
            if (handle == IntPtr.Zero) return null;
            IntPtr locked = Win32.GlobalLock(handle);
            if (locked == IntPtr.Zero) return null;
            try
            {
                UIntPtr size = Win32.GlobalSize(handle);
                if (size == UIntPtr.Zero) return null;
                byte[] bytes = new byte[(int)size];
                Marshal.Copy(locked, bytes, 0, bytes.Length);
                return bytes;
            }
            finally
            {
                Win32.GlobalUnlock(handle);
            }
        }

        private static bool WriteFormat(uint format, byte[] bytes)
        {
            IntPtr handle = Win32.GlobalAlloc(Win32.GMEM_MOVEABLE, (UIntPtr)bytes.Length);
            if (handle == IntPtr.Zero) return false;
            IntPtr locked = Win32.GlobalLock(handle);
            if (locked == IntPtr.Zero)
            {
                Win32.GlobalFree(handle);
                return false;
            }
            try
            {
                Marshal.Copy(bytes, 0, locked, bytes.Length);
            }
            finally
            {
                Win32.GlobalUnlock(handle);
            }
            // 交出去之后这块内存归系统管，不能再 GlobalFree
            return Win32.SetClipboardData(format, handle) != IntPtr.Zero;
        }

        /// <summary>把存下来的内容还回去。先清空再一个个放进，清空是唯一能把刚才那句话去掉的办法</summary>
        public static void Restore(List<Entry> saved)
        {
            WithClipboard(() =>
            {
                Win32.EmptyClipboard();
                // 单个格式失败不该让整个还原停在这里：能还几样是几样
                foreach (Entry entry in saved) WriteFormat(entry.Format, entry.Bytes);
            });
        }

        /// <summary>
        /// 把文字放进剪贴板（只有文字）。
        ///
        /// 同时打上"别记我"的标记，这是原版那个"临时内容"标记在 Windows 上的对应物
        /// （docs/targets/typeless/docs/07-native-helpers.md 的备忘第 3 条：写入要带临时标记）。
        /// 不收标记得话，Win+V 的历史和云剪贴板会把你说的话存下来——那是隐私问题：
        /// 这些字本来是"贴进输入框"的，不该在剪贴板历史里留一份。
        /// 三个格式各自管一块：CanIncludeInClipboardHistory=0 关掉 Win+V 记录，
        /// CanUploadToCloudClipboard=0 关掉跨设备同步，ExcludeClipboardContentFromMonitoring 是
        /// 剪贴板管理器之间通行的"本次不要处理"约定。
        /// </summary>
        public static void WriteText(string text)
        {
            WithClipboard(() =>
            {
                Win32.EmptyClipboard();
                byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                if (!WriteFormat(Win32.CF_UNICODETEXT, bytes)) throw new InvalidOperationException("写不进剪贴板");
                MarkNotForHistory();
            });
        }

        /// <summary>那三个"别记我"的格式名系统认不认。认不出来时标记写了也没用，自检要把这件事说出来</summary>
        public static bool NotForHistoryMarkersRegistered()
        {
            return Win32.RegisterClipboardFormat("CanIncludeInClipboardHistory") != 0
                && Win32.RegisterClipboardFormat("CanUploadToCloudClipboard") != 0
                && Win32.RegisterClipboardFormat("ExcludeClipboardContentFromMonitoring") != 0;
        }

        /// <summary>给这次写入打上"不进剪贴板历史、不上云"的标记。格式名是 Windows 自己认的那几个</summary>
        private static void MarkNotForHistory()
        {
            uint canInclude = Win32.RegisterClipboardFormat("CanIncludeInClipboardHistory");
            if (canInclude != 0) WriteFormat(canInclude, BitConverter.GetBytes((uint)0));
            uint canUpload = Win32.RegisterClipboardFormat("CanUploadToCloudClipboard");
            if (canUpload != 0) WriteFormat(canUpload, BitConverter.GetBytes((uint)0));
            uint exclude = Win32.RegisterClipboardFormat("ExcludeClipboardContentFromMonitoring");
            if (exclude != 0) WriteFormat(exclude, new byte[4]);
        }

        /// <summary>现在剪贴板里的文字。没有文字时是空字符串</summary>
        public static string ReadText()
        {
            return WithClipboard(() =>
            {
                byte[] bytes = ReadFormat(Win32.CF_UNICODETEXT);
                if (bytes == null) return string.Empty;
                return Encoding.Unicode.GetString(bytes).TrimEnd('\0');
            });
        }

        public static bool HasText()
        {
            return Win32.IsClipboardFormatAvailable(Win32.CF_UNICODETEXT) != 0;
        }
    }

    internal static class Paste
    {
        /// <summary>模拟粘贴之后等多久再恢复剪贴板。和原版一样的 0.3 秒</summary>
        public const int RestoreDelayMilliseconds = 300;

        /// <summary>
        /// 发一次 Ctrl+V。
        /// @returns 一条没排进系统输入队列时是 false，error 里是 GetLastError。
        ///   87（ERROR_INVALID_PARAMETER）说明 INPUT 的大小不对（这里最容易错，见过 56 vs 40 那次）；
        ///   5（ERROR_ACCESS_DENIED）才是被 UIPI 拦下的那种
        /// </summary>
        public static bool SendControlV(out uint error)
        {
            var inputs = new Win32.INPUT[4];
            inputs[0].type = Win32.INPUT_KEYBOARD;
            inputs[0].ki.wVk = (ushort)Win32.VK_CONTROL;
            inputs[1].type = Win32.INPUT_KEYBOARD;
            inputs[1].ki.wVk = (ushort)Win32.VK_V;
            inputs[2].type = Win32.INPUT_KEYBOARD;
            inputs[2].ki.wVk = (ushort)Win32.VK_V;
            inputs[2].ki.dwFlags = Win32.KEYEVENTF_KEYUP;
            inputs[3].type = Win32.INPUT_KEYBOARD;
            inputs[3].ki.wVk = (ushort)Win32.VK_CONTROL;
            inputs[3].ki.dwFlags = Win32.KEYEVENTF_KEYUP;
            uint sent = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
            if (sent == inputs.Length)
            {
                error = 0;
                return true;
            }
            error = (uint)Marshal.GetLastWin32Error();
            return false;
        }

        /// <summary>
        /// 前台窗口所在的进程是不是比我们"更高"，也就是 UIPI 会不会拦下我们发的按键。
        ///
        /// 判断依据是提权状态：被提权（以管理员身份运行）的进程发不了进低权限窗口，反过来低权限发不进高权限。
        /// 我们自己是普通权限时，对面提权了就一定贴不进去——这时候直接回 `uipi_blocked`，
        /// 让主进程把"文字留在剪贴板、按 Ctrl+V 自己贴"那句话说出来，而不是假装贴成功了。
        /// （docs/targets/typeless/docs/14-result-delivery.md 的备忘第 1 条：不可写时给复制兜底。）
        /// </summary>
        public static bool ForegroundBlocksInput()
        {
            if (IsElevated(Win32.GetCurrentProcess())) return false;
            IntPtr foreground = Win32.GetForegroundWindow();
            if (foreground == IntPtr.Zero) return false;
            uint pid;
            Win32.GetWindowThreadProcessId(foreground, out pid);
            if (pid == 0) return false;
            IntPtr process = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return false;
            try
            {
                return IsElevated(process);
            }
            finally
            {
                Win32.CloseHandle(process);
            }
        }

        /// <summary>这个进程的令牌有没有被提权。查不了时当作"没提权"：宁可多贴一次，也别拦下能贴的</summary>
        private static bool IsElevated(IntPtr process)
        {
            IntPtr token;
            if (!Win32.OpenProcessToken(process, Win32.TOKEN_QUERY, out token)) return false;
            try
            {
                uint elevated;
                uint returned;
                if (!Win32.GetTokenInformation(token, Win32.TokenElevation, out elevated, sizeof(uint), out returned)) return false;
                return elevated != 0;
            }
            finally
            {
                Win32.CloseHandle(token);
            }
        }

        /// <summary>
        /// 只验证 SendInput 通不通：发一个没人绑定的 F24（按下 + 松开），看返回值。
        /// 不碰剪贴板、不影响前台，适合放进自检里当常驻的一道闸。
        /// 返回 2 说明 INPUT 结构体大小对上了、按键排进了输入队列；
        /// 返回 0 时 error 里是 GetLastError（87 = 结构体大小不对，5 = 被 UIPI 拦了）。
        /// </summary>
        public static bool SendProbe(out uint error, out uint sent)
        {
            var inputs = new Win32.INPUT[2];
            inputs[0].type = Win32.INPUT_KEYBOARD;
            inputs[0].ki.wVk = (ushort)Win32.VK_F24;
            inputs[1].type = Win32.INPUT_KEYBOARD;
            inputs[1].ki.wVk = (ushort)Win32.VK_F24;
            inputs[1].ki.dwFlags = Win32.KEYEVENTF_KEYUP;
            sent = Win32.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
            error = sent == inputs.Length ? 0 : (uint)Marshal.GetLastWin32Error();
            return sent == inputs.Length;
        }

        /// <summary>
        /// 存剪贴板 → 写入文字 → Ctrl+V → 恢复剪贴板。
        ///
        /// 失败时**不还原**：文字留在剪贴板里。这是"粘贴失败不能让用户丢字"的落地点
        /// （逆向笔记 14 的备忘第 1 条）。失败时也还原的话，那句"文字已复制，按 Ctrl+V"就是假话，
        /// 用户按下去什么都没有。
        /// @returns { ok, reason }：ok 为 false 时剪贴板里留着这次的文字
        /// </summary>
        public static Result Deliver(string text)
        {
            List<Clipboard.Entry> saved;
            try
            {
                saved = Clipboard.Snapshot();
            }
            catch (Exception)
            {
                // 存不下来就还不了。这时候不能往下走，否则会把人家复制的东西吃掉；
                // 这次没能把文字写进去，由主进程那边补一份（delivery.mjs 在 ok 为 false 时会写剪贴板）
                return new Result { Ok = false, Reason = "clipboard_busy" };
            }
            try
            {
                Clipboard.WriteText(text);
            }
            catch (Exception)
            {
                return new Result { Ok = false, Reason = "clipboard_busy" };
            }
            // 对面是高权限窗口时不要白发一次：SendInput 会"成功"、按键却进不去，
            // 结果是我们报贴好了、用户什么都没看到。文字已经写进剪贴板了，就留在那儿
            if (ForegroundBlocksInput()) return new Result { Ok = false, Reason = "uipi_blocked" };
            // 这个编译器的语言版本到 C# 5（.NET Framework 4 的 csc），所以 out 变量要事先声明、
            // 也不能用 $"" 插值——写成拼接
            uint error;
            if (!SendControlV(out error))
            {
                // 带上错误码：87 是 INPUT 大小不对（曾经踩过），5 是真被拦了，别的再查
                return new Result { Ok = false, Reason = "input_blocked:" + error };
            }
            // 贴出去了才还原：等一下，目标应用要有一点时间把剪贴板读走
            Thread.Sleep(RestoreDelayMilliseconds);
            try
            {
                Clipboard.Restore(saved);
            }
            catch (Exception)
            {
                // 还原不回去只影响"人家原来复制的东西"，已经贴出去的字不受影响
            }
            return new Result { Ok = true };
        }

        public struct Result
        {
            public bool Ok;
            public string Reason;
        }
    }
}
