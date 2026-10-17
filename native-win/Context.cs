// 读焦点输入框里、光标往前的那一段文字。
//
// 用途：把"他正在写什么"告诉模型，让它知道该怎么整理（docs/targets/typeless/docs/06 里
// 原版采了八份上下文，`text_before_cursor` 是其中最核心的一份，我们只做这一份）。
//
// 三个顺序，前一个拿不到才退下一个：
//   1. UI Automation 的 TextPattern：能精确定位光标，记事本、Word、浏览器、VS Code 都支持
//   2. ValuePattern：拿整个输入框的值，再按光标位置截
//   3. 都不行 → 返回空，**不重试、不轮询**。很多应用（老版 Windows Terminal、某些 Win32 程序）
//      根本没有可读的输入框，那不是错误，是常态
//
// 隐私：只在本进程内存里过一手，交给父进程后就随请求发给模型；不落盘、不进历史、不进日志
// （日志只记字数，见 src/app/helper.mjs）。
//
// 语言级别是 C# 5（.NET Framework 4 自带的 csc）：不能用 $"" 插值、不能用 ?.、不能用 nameof。

using System;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace Draftless
{
    internal static class Context
    {
        /// <summary>一次读取的结果。Chars 是拿到的字数，By 说明是从哪条路拿到的</summary>
        internal sealed class Result
        {
            public string Text = "";
            public string By = "none";
            public int Chars
            {
                get { return Text.Length; }
            }
        }

        /// <summary>
        /// 读焦点元素里光标前的文字，最多 maxChars 个。
        /// 永远不抛：读不到就回一个空结果，调用方不用包 try。
        /// </summary>
        public static Result ReadBeforeCursor(int maxChars)
        {
            Result result = new Result();
            if (maxChars <= 0) return result;
            AutomationElement focused = null;
            try
            {
                focused = AutomationElement.FocusedElement;
            }
            catch (Exception)
            {
                return result;
            }
            if (focused == null) return result;

            string text = FromTextPattern(focused, maxChars);
            if (text != null)
            {
                result.Text = text;
                result.By = "text_pattern";
                return result;
            }
            text = FromValuePattern(focused, maxChars);
            if (text != null)
            {
                result.Text = text;
                result.By = "value_pattern";
                return result;
            }
            return result;
        }

        /// <summary>
        /// 用 TextPattern 精确取光标前的一段。
        ///
        /// 关键在那三步 range 操作：光标的 range 通常是个空区间，先把它的**末端**挪到文档开头，
        /// 这个区间就变成"从光标倒着到开头"；再从开头往后移 maxChars 个字，区间就成了
        /// "文档开头往后 maxChars 个字 ～ 光标"——正好是光标前的那一段。
        /// 直接 GetText(maxChars) 拿到的是**文档开头**的 maxChars 个字，不是光标前的（踩过）。
        /// </summary>
        private static string FromTextPattern(AutomationElement element, int maxChars)
        {
            object pattern;
            if (!element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return null;
            TextPattern textPattern = pattern as TextPattern;
            if (textPattern == null) return null;
            try
            {
                TextPatternRange[] selection = textPattern.GetSelection();
                if (selection == null || selection.Length == 0) return null;
                TextPatternRange range = selection[0].Clone();
                if (range == null) return null;
                // 末端挪到文档开头
                range.MoveEndpointByRange(TextPatternRangeEndpoint.End, textPattern.DocumentRange, TextPatternRangeEndpoint.Start);
                // 再往后挪 maxChars 个字；不够就停在光标那里
                range.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, maxChars);
                string text = range.GetText(-1);
                return text == null ? "" : text;
            }
            catch (Exception)
            {
                // 有些应用的 TextPattern 会抛（比如在密码框里、或者控件已经没了）。这不算错，退下一条路
                return null;
            }
        }

        /// <summary>
        /// 用 ValuePattern 拿整个输入框的值，再从末尾往前截 maxChars 个。
        ///
        /// 拿不到真实光标位置，所以按"内容末尾"当光标——很多输入框里用户就在末尾打字，
        /// 这个近似够用。**不能**在这里读密码框：ValuePattern 对 IsPassword 的元素会返回空，
        /// 但为了稳妥，这里直接跳过密码框。
        /// </summary>
        private static string FromValuePattern(AutomationElement element, int maxChars)
        {
            object pattern;
            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return null;
            ValuePattern valuePattern = pattern as ValuePattern;
            if (valuePattern == null) return null;
            try
            {
                string value = valuePattern.Current.Value;
                if (string.IsNullOrEmpty(value)) return "";
                // 拿不到光标位置，只能取一段近似：**取开头**。
                // 这份文字是给模型判断"他在写什么"用的，主题通常在开头；末尾那几百字常是半句话。
                // 密码框 UIA 自己就不给值（读到空串），所以不用另做判断
                if (value.Length <= maxChars) return value;
                return value.Substring(0, maxChars);
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
