// fast-speak 的原生小帮手入口。
//
// 这是 Windows 实现，命令行和通信协议一模一样，
// 所以父进程（src/app/helper.mjs）那一层不用为平台分叉。
//
// 为什么是一个独立进程而不是在主进程里直接调 Win32：低层钩子必须装在跑消息循环的那个线程上。
// 试过用 koffi 在 Electron 主进程里开原生线程装钩子——钩子能装上，但原生线程一回调 JS，
// Node 的主线程就被饿死（实测主线程定时器 1.2 秒只跑了 2 拍而不是 12 拍）。关在自己的进程里，
// 主进程只剩"一行 JSON 进、一行 JSON 出"，和原版的做法一致。
// 用法：
//   draftless-helper.exe [--key right_alt|right_ctrl|right_shift|right_win] [--capture-limit 秒]
//   draftless-helper.exe --selftest     自检剪贴板存取能原样还原，退出码 0/1
//   draftless-helper.exe --check        只报一份能力状态就退出
//
// 父进程退出（标准输入关闭）时自己也退出。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;

namespace Draftless
{
    internal static class Program
    {
        public static int Main(string[] arguments)
        {
            string hotkeyName = "right_alt";
            int captureLimit = 600;
            for (int i = 0; i < arguments.Length; i++)
            {
                if (arguments[i] == "--key" && i + 1 < arguments.Length)
                {
                    string wanted = arguments[i + 1].Trim().ToLowerInvariant();
                    string resolved;
                    if (Hooks.Aliases.TryGetValue(wanted, out resolved)) wanted = resolved;
                    if (!Hooks.Hotkeys.ContainsKey(wanted))
                    {
                        Protocol.Error("不认识的热键 " + wanted + "，可选：" + string.Join("、", SortedNames()));
                        return 2;
                    }
                    hotkeyName = wanted;
                }
                else if (arguments[i] == "--capture-limit" && i + 1 < arguments.Length)
                {
                    int parsed;
                    if (int.TryParse(arguments[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                    {
                        captureLimit = parsed;
                    }
                }
            }

            if (Array.IndexOf(arguments, "--selftest") >= 0)
            {
                return SelfTest.Run() ? 0 : 1;
            }
            // 一次性读光标前的文字：排障时用（"为什么没拿到上下文"）、也给测试用。
            // 正常运行时走的是 stdin 上的 context 命令，那条路在异步线程里跑、父进程一直在等
            int contextAt = Array.IndexOf(arguments, "--context");
            if (contextAt >= 0)
            {
                int wanted = 500;
                if (contextAt + 1 < arguments.Length)
                {
                    int parsed;
                    if (int.TryParse(arguments[contextAt + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed > 0)
                        wanted = parsed;
                }
                Context.Result oneShot = Context.ReadBeforeCursor(wanted);
                Protocol.Context(oneShot.Text, oneShot.By);
                return 0;
            }

            var hooks = new Hooks(hotkeyName, captureLimit);
            hooks.Start();
            // 钩子线程装钩子那一小会儿先等一等：--check 要报的是"装上了没有"，
            // 而读标准输入那边也不该在 ready 之前就开始接命令
            bool becameReady = hooks.WaitUntilReady(3000);

            if (Array.IndexOf(arguments, "--check") >= 0)
            {
                if (!becameReady) Protocol.Error("钩子线程 3 秒内没有报 ready");
                else hooks.ReportCheck();
                hooks.Stop();
                return 0;
            }

            if (!becameReady) Protocol.Error("钩子线程 3 秒内没有报 ready，热键可能收不到");

            string line;
            while ((line = Protocol.ReadLine()) != null)
            {
                Dispatch(hooks, line);
            }

            // 父进程关掉了标准输入：收摊。还按着的键要吞完，钩子先别急着卸
            Thread.Sleep(50);
            hooks.Stop();
            return 0;
        }

        private static void Dispatch(Hooks hooks, string line)
        {
            Dictionary<string, object> command = Json.ParseObject(line);
            if (command == null)
            {
                Protocol.Error("看不懂的 JSON");
                return;
            }
            string name = command.GetString("cmd");
            if (name == "paste")
            {
                int id;
                string text = command.GetString("text");
                if (!command.TryGetInt("id", out id) || text == null)
                {
                    Protocol.Error("paste 需要 id 和 text");
                    return;
                }
                // 贴字要动剪贴板、还要等 0.3 秒再还原，不能占着钩子线程：交给线程池
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try
                    {
                        Paste.Result result = Paste.Deliver(text);
                        Protocol.Pasted(id, result.Ok, result.Reason);
                    }
                    catch (Exception error)
                    {
                        Protocol.Pasted(id, false, "paste_failed");
                        Protocol.Error(error.Message);
                    }
                });
                return;
            }
            if (name == "capture")
            {
                Region[] parsed = ParseRegions(command);
                if (parsed == null)
                {
                    Protocol.Error("capture 需要 regions：一组 { id, x, y, width, height }");
                    return;
                }
                hooks.SetCapture(parsed);
                return;
            }
            if (name == "mute")
            {
                // 录音开始：记住用户原来的静音状态，然后静音，扬声器的声音不会回灌进麦克风
                Audio.MuteForRecording();
                return;
            }
            if (name == "unmute")
            {
                // 录音结束：还原成用户原来的静音状态，不是无条件打开声音
                Audio.RestoreAfterRecording();
                return;
            }
            if (name == "context")
            {
                int maxChars;
                if (!command.TryGetInt("maxChars", out maxChars) || maxChars <= 0) maxChars = 500;
                // UIA 调用可能要几百毫秒（有些应用的辅助功能树很慢），不能占着钩子线程：交给线程池。
                // 读不到是常态（老 Win32 程序、密码框），回一个 chars:0 就算完事，父进程不重试
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try
                    {
                        Context.Result result = Context.ReadBeforeCursor(maxChars);
                        Protocol.Context(result.Text, result.By);
                    }
                    catch (Exception error)
                    {
                        Protocol.Context("", "none");
                        Protocol.Error(error.Message);
                    }
                });
                return;
            }
            if (name == "release")
            {
                hooks.SetCapture(null);
                return;
            }
            if (name == "check")
            {
                hooks.ReportCheck();
                return;
            }
            Protocol.Error("不认识的命令：" + name);
        }

        /// <summary>页面报上来的区域。缺字段、大小非正都算无效（和原版的区域解析规则一样）</summary>
        private static Region[] ParseRegions(Dictionary<string, object> command)
        {
            List<object> list = command.GetArray("regions");
            if (list == null) return null;
            var parsed = new Region[list.Count];
            for (int i = 0; i < list.Count; i++)
            {
                Dictionary<string, object> item = list.GetObject(i);
                if (item == null) return null;
                string id = item.GetString("id");
                double? x = item.GetNumber("x");
                double? y = item.GetNumber("y");
                double? width = item.GetNumber("width");
                double? height = item.GetNumber("height");
                if (id == null || x == null || y == null || width == null || height == null) return null;
                if (width <= 0 || height <= 0) return null;
                parsed[i] = new Region
                {
                    Id = id,
                    X = (int)Math.Round(x.Value),
                    Y = (int)Math.Round(y.Value),
                    Width = (int)Math.Round(width.Value),
                    Height = (int)Math.Round(height.Value),
                };
            }
            return parsed;
        }

        private static string[] SortedNames()
        {
            var names = new List<string>(Hooks.Hotkeys.Keys);
            names.Sort(StringComparer.Ordinal);
            return names.ToArray();
        }
    }

    /// <summary>自检：剪贴板能原样还原、能发按键。不碰任何窗口，也不留痕迹</summary>
    internal static class SelfTest
    {
        public static bool Run()
        {
            bool wroteText = false;
            bool restored = false;
            int items = 0;
            try
            {
                List<Clipboard.Entry> before = Clipboard.Snapshot();
                items = before.Count;
                Clipboard.WriteText("draftless 自检");
                wroteText = Clipboard.ReadText() == "draftless 自检";
                Clipboard.Restore(before);
                List<Clipboard.Entry> after = Clipboard.Snapshot();
                restored = before.Count == after.Count;
                for (int i = 0; restored && i < before.Count; i++)
                {
                    if (before[i].Format != after[i].Format) restored = false;
                }
            }
            catch (Exception error)
            {
                Protocol.Error(error.Message);
            }
            // 三个"别记我"的格式名要能被系统认出来（RegisterClipboardFormat 返回 0 就是没这个格式）。
            // 认不出来的话那几行标记就是白写的，Win+V 里照样会留下你说的话——这一项要能被看见
            bool markers = Clipboard.NotForHistoryMarkersRegistered();
            // INPUT 的大小必须是 Windows 认的 40。错一个字节 SendInput 就一个键都不发（返回 0），
            // 表现出来是"文字生成了但贴不进光标"，而且很容易被误当成权限问题。
            // 这一项一定要能被看见：之前垫了三个 long 变成 56，线上就是每次都贴不进去
            int inputSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Win32.INPUT));
            bool inputLayout = inputSize == 40;
            // 光看大小不够：真发一次按键，确认它排进了输入队列（发的是没人绑定的 F24）。
            // 这一项是"文字能不能贴进光标"的唯一机器证据——之前结构体大 8 字节，SendInput 一直是 0
            uint sendError;
            uint sendSent;
            bool canSend = Paste.SendProbe(out sendError, out sendSent);
            // 静音往返：静音 → 读回 → 还原 → 读回。没有音频设备时是 null，那一项不适用、不算失败
            bool? audioRoundTrip = Audio.SelfTest();
            bool audioOk = audioRoundTrip != false;
            Protocol.Emit("{\"event\":\"selftest\",\"wrote_text\":" + Json.Bool(wroteText)
                          + ",\"restored\":" + Json.Bool(restored) + ",\"items\":" + items
                          + ",\"not_for_history_markers\":" + Json.Bool(markers)
                          + ",\"input_size\":" + inputSize + ",\"input_layout\":" + Json.Bool(inputLayout)
                          + ",\"send_input\":" + Json.Bool(canSend) + ",\"send_sent\":" + sendSent
                          + ",\"send_error\":" + sendError
                          + ",\"audio_mute\":" + Json.Bool(audioOk) + "}");
            return wroteText && restored && markers && inputLayout && canSend && audioOk;
        }
    }
}
