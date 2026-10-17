// 一行的 JSON 读写。只用得到协议里那几种：对象、字符串、数字、数组、布尔。
// 为什么自己写而不是引一个库：.NET Framework 里没有 System.Text.Json，System.Web.Extensions 又要在编译时
// 多挂一个引用；这边的语法只有几行，自己写反而少一层依赖，也不受本机装了什么的影响。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Draftless
{
    internal static class Json
    {
        /// <summary>把文字写成 JSON 字符串字面量（带引号）</summary>
        public static string String(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < ' ')
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Bool(bool value)
        {
            return value ? "true" : "false";
        }

        /// <summary>
        /// 解析一个 JSON 对象。看不懂时返回 null——调用方据此回一句"看不懂"，
        /// 而不是让整个进程崩掉（父进程收到一堆错误总比收不到强）。
        /// </summary>
        public static Dictionary<string, object> ParseObject(string text)
        {
            try
            {
                int index = 0;
                object value = ParseValue(text, ref index);
                SkipSpace(text, ref index);
                if (index != text.Length) return null;
                return value as Dictionary<string, object>;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static object ParseValue(string text, ref int index)
        {
            SkipSpace(text, ref index);
            if (index >= text.Length) throw new FormatException("提前结束");
            char c = text[index];
            switch (c)
            {
                case '{': return ParseObjectBody(text, ref index);
                case '[': return ParseArrayBody(text, ref index);
                case '"': return ParseString(text, ref index);
                case 't': Expect(text, ref index, "true"); return true;
                case 'f': Expect(text, ref index, "false"); return false;
                case 'n': Expect(text, ref index, "null"); return null;
                default: return ParseNumber(text, ref index);
            }
        }

        private static Dictionary<string, object> ParseObjectBody(string text, ref int index)
        {
            var result = new Dictionary<string, object>(StringComparer.Ordinal);
            index++; // {
            SkipSpace(text, ref index);
            if (index < text.Length && text[index] == '}')
            {
                index++;
                return result;
            }
            while (true)
            {
                SkipSpace(text, ref index);
                if (index >= text.Length || text[index] != '"') throw new FormatException("键必须是字符串");
                string key = ParseString(text, ref index);
                SkipSpace(text, ref index);
                if (index >= text.Length || text[index] != ':') throw new FormatException("少了冒号");
                index++;
                result[key] = ParseValue(text, ref index);
                SkipSpace(text, ref index);
                if (index >= text.Length) throw new FormatException("提前结束");
                if (text[index] == ',')
                {
                    index++;
                    continue;
                }
                if (text[index] == '}')
                {
                    index++;
                    return result;
                }
                throw new FormatException("对象里出现了不认识的东西");
            }
        }

        private static List<object> ParseArrayBody(string text, ref int index)
        {
            var result = new List<object>();
            index++; // [
            SkipSpace(text, ref index);
            if (index < text.Length && text[index] == ']')
            {
                index++;
                return result;
            }
            while (true)
            {
                result.Add(ParseValue(text, ref index));
                SkipSpace(text, ref index);
                if (index >= text.Length) throw new FormatException("提前结束");
                if (text[index] == ',')
                {
                    index++;
                    continue;
                }
                if (text[index] == ']')
                {
                    index++;
                    return result;
                }
                throw new FormatException("数组里出现了不认识的东西");
            }
        }

        private static string ParseString(string text, ref int index)
        {
            index++; // "
            var sb = new StringBuilder();
            while (true)
            {
                if (index >= text.Length) throw new FormatException("字符串没有结束");
                char c = text[index++];
                if (c == '"') return sb.ToString();
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (index >= text.Length) throw new FormatException("转义没有写完");
                char escape = text[index++];
                switch (escape)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (index + 4 > text.Length) throw new FormatException("\\u 没有写完");
                        sb.Append((char)int.Parse(text.Substring(index, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        index += 4;
                        break;
                    default: throw new FormatException("不认识的转义");
                }
            }
        }

        private static double ParseNumber(string text, ref int index)
        {
            int start = index;
            if (index < text.Length && (text[index] == '-' || text[index] == '+')) index++;
            while (index < text.Length)
            {
                char c = text[index];
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+') index++;
                else break;
            }
            if (start == index) throw new FormatException("这里应该是个数字");
            return double.Parse(text.Substring(start, index - start), CultureInfo.InvariantCulture);
        }

        private static void Expect(string text, ref int index, string word)
        {
            if (index + word.Length > text.Length || string.CompareOrdinal(text, index, word, 0, word.Length) != 0)
            {
                throw new FormatException("这里应该是 " + word);
            }
            index += word.Length;
        }

        private static void SkipSpace(string text, ref int index)
        {
            while (index < text.Length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\n' || text[index] == '\r'))
            {
                index++;
            }
        }

        // ---- 取值：命令里要什么就取什么，类型不对当没有 ----

        public static string GetString(this Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value)) return null;
            return value as string;
        }

        public static bool TryGetInt(this Dictionary<string, object> source, string key, out int result)
        {
            result = 0;
            object value;
            if (source == null || !source.TryGetValue(key, out value)) return false;
            if (!(value is double)) return false;
            double number = (double)value;
            if (number != Math.Floor(number)) return false;
            if (number < int.MinValue || number > int.MaxValue) return false;
            result = (int)number;
            return true;
        }

        public static double? GetNumber(this Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value)) return null;
            if (value is double) return (double)value;
            return null;
        }

        public static List<object> GetArray(this Dictionary<string, object> source, string key)
        {
            object value;
            if (source == null || !source.TryGetValue(key, out value)) return null;
            return value as List<object>;
        }

        public static Dictionary<string, object> GetObject(this List<object> source, int index)
        {
            if (source == null || index < 0 || index >= source.Count) return null;
            return source[index] as Dictionary<string, object>;
        }
    }
}
