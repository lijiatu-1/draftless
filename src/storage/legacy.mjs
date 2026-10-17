// Windows 版是第一个版本，没有别处的旧数据要搬。
//
// 原版这里做的是"把 ~/Library/Application Support/draftless 里的东西搬进 ~/.draftless"
// 。那边是版本演进留下的历史；这边没有那段历史，
// 所以留一个返回"没搬任何东西"的函数，让调用的地方（命令行的入口、后台应用的启动）不用分平台，
// 以后真需要搬家时也有同一个位置可放。

/**
 * @returns {Promise<string[]>} 搬了哪几样。这一版永远是空的
 */
export async function migrateLegacyData() {
  return [];
}
