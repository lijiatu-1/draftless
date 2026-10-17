// 协议的那一层：往标准输出写一行 JSON，从标准输入读一行 JSON。
// 字段和原版逐个对齐，父进程那一侧不用为 Windows 改一行。
//
// 一律按 UTF-8 读写，不用 Console.Out / Console.In：那两个按控制台的代码页编码，
// 中文系统上是 GBK，父进程那边按 UTF-8 解就成乱码。管道（父进程 spawn 出来的）和重定向都走这一层。

using System;
using System.IO;
using System.Text;

namespace Draftless
{
    internal static class Protocol
    {
        /// <summary>输出要串行：钩子线程、线程池里贴字的那个、读标准输入的这个都会往这里写</summary>
        private static readonly object gate = new object();
        private static readonly UTF8Encoding utf8 = new UTF8Encoding(false);
        private static StreamWriter writer;
        private static StreamReader reader;

        private static StreamWriter Out
        {
            get
            {
                if (writer == null)
                {
                    // 不要 BOM：父进程按行读 JSON，开头多三个字节会解析失败
                    writer = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
                }
                return writer;
            }
        }

        private static StreamReader In
        {
            get
            {
                if (reader == null) reader = new StreamReader(Console.OpenStandardInput(), utf8);
                return reader;
            }
        }

        public static void Emit(string json)
        {
            lock (gate)
            {
                try
                {
                    Out.WriteLine(json);
                    Out.Flush();
                }
                catch (Exception)
                {
                    // 父进程已经走了。读标准输入那边会收到 EOF 并把进程收掉，这里不用另做处置
                }
            }
        }

        /// <summary>从标准输入读一行；读不到（父进程关掉了入口）时返回 null</summary>
        public static string ReadLine()
        {
            try
            {
                return In.ReadLine();
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static void Error(string message)
        {
            Emit("{\"event\":\"error\",\"message\":" + Json.String(message) + "}");
        }

        /// <summary>
        /// 启动完成，报两把钩子装上没有。
        ///
        /// 三个名字沿用 原版的协议，含义按 Windows 的事实来：
        /// - listen = 键盘钩子装上了（没装上就听不到热键）
        /// - trusted = 鼠标钩子装上了（没装上就拦不住 esc 和悬浮条上的点击；macOS 上这个是辅助功能权限）
        /// - capture = 同一个鼠标钩子，主进程用它决定悬浮条要不要画 ✕/✓
        /// trusted 照着鼠标钩子报，不是写死 true：写死的话"点击拦截没装上"这件事永远说不出来，
        /// 缺了降级提示（setup-state.mjs 的 degraded）就永远不触发。
        /// </summary>
        public static void Ready(bool listen, bool capture)
        {
            Emit("{\"event\":\"ready\",\"listen\":" + Json.Bool(listen) + ",\"trusted\":" + Json.Bool(capture)
                 + ",\"capture\":" + Json.Bool(capture) + "}");
        }

        public static void Hotkey(bool down)
        {
            Emit("{\"event\":\"hotkey\",\"down\":" + Json.Bool(down) + "}");
        }

        public static void OtherKey()
        {
            Emit("{\"event\":\"other_key\"}");
        }

        public static void Pasted(int id, bool ok, string reason)
        {
            Emit("{\"event\":\"pasted\",\"id\":" + id + ",\"ok\":" + Json.Bool(ok)
                 + (reason == null ? string.Empty : ",\"reason\":" + Json.String(reason)) + "}");
        }

        public static void Escape()
        {
            Emit("{\"event\":\"escape\"}");
        }

        public static void Click(string id)
        {
            Emit("{\"event\":\"click\",\"id\":" + Json.String(id) + "}");
        }

        /// <summary>
        /// 光标前的文字读到了。
        /// by 说明是从哪条路拿到的（text_pattern / value_pattern / none），拿不到时 chars 是 0——
        /// 那不算失败（很多应用根本没有可读的输入框），父进程不用重试。
        /// </summary>
        public static void Context(string text, string by)
        {
            string safe = text == null ? string.Empty : text;
            Emit("{\"event\":\"context\",\"by\":" + Json.String(by)
                 + ",\"chars\":" + safe.Length + ",\"text\":" + Json.String(safe) + "}");
        }
    }
}
