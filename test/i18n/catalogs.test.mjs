import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULT_LOCALE, findLocale, LOCALES } from "../../src/i18n/index.mjs";
import { PROVIDERS } from "../../src/server/providers/index.mjs";
import { HOTKEY_IDS, SETTINGS } from "../../src/storage/settings.mjs";
import { THEMES } from "../../src/themes/index.mjs";

// 每种语言的文案都齐、参数都对得上；代码里用到的名字都有。加一种语言时这几条会指出缺了什么。

const base = findLocale(DEFAULT_LOCALE).messages;
const isPlural = (node) => node !== null && typeof node === "object" && typeof node.other === "string";

/** 拍平成 名字 → 模板（分单复数的是 { one, other }） */
function flatten(node, prefix = "", out = new Map()) {
  for (const [name, value] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string" || isPlural(value)) out.set(key, value);
    else flatten(value, key, out);
  }
  return out;
}

const placeholders = (template) =>
  new Set(
    (isPlural(template) ? Object.values(template) : [template]).flatMap((text) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]),
    ),
  );

const baseKeys = flatten(base);

for (const locale of LOCALES) {
  test(`${locale.id}：和英文的名字一一对上，每句的参数也一样`, () => {
    const keys = flatten(locale.messages);
    assert.deepEqual(
      [...keys.keys()].filter((key) => !baseKeys.has(key)),
      [],
      "多出来的",
    );
    assert.deepEqual(
      [...baseKeys.keys()].filter((key) => !keys.has(key)),
      [],
      "缺的",
    );
    for (const [key, template] of keys) {
      assert.deepEqual(placeholders(template), placeholders(baseKeys.get(key)), key);
    }
  });

  test(`${locale.id}：分单复数的只用这种语言有的写法，other 一定有`, () => {
    const categories = new Intl.PluralRules(locale.id).resolvedOptions().pluralCategories;
    for (const [key, template] of flatten(locale.messages)) {
      if (!isPlural(template)) continue;
      for (const form of Object.keys(template)) assert.ok(categories.includes(form), `${key} 的 ${form}`);
    }
  });
}

test("动态拼出来的名字也都有：每个热键、主题、厂商、设置项", () => {
  const needed = [
    ...HOTKEY_IDS.flatMap((id) => [`hotkeys.${id}.name`, `hotkeys.${id}.keycap`]),
    ...THEMES.flatMap(({ id }) => [`themes.${id}.name`, `themes.${id}.describe`]),
    ...PROVIDERS.map(({ id }) => `providers.${id}.getKey`),
    ...Object.keys(SETTINGS).map((name) => `settings.describe.${name}`),
  ];
  assert.deepEqual(
    needed.filter((key) => !baseKeys.has(key)),
    [],
  );
});

/** 仓库里的源码文件 */
function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : sourceFiles(path);
    return /\.(mjs|cjs|html)$/.test(name) ? [path] : [];
  });
}

test("代码里写死的名字（t、msg、parts、data-i18n）在英文里都有", () => {
  const root = resolve(import.meta.dirname, "../..");
  const used = new Map();
  const patterns = [/\bt(?:\.parts)?\(\s*"([\w.]+)"/g, /\bmsg\(\s*"([\w.]+)"/g, /data-i18n(?:-[\w-]+)?="([\w.]+)"/g];
  for (const file of [...sourceFiles(join(root, "src")), join(root, "bin/draftless.mjs")]) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) used.set(match[1], file.slice(root.length + 1));
    }
  }
  assert.ok(used.size > 100, `只找到 ${used.size} 个，扫描的写法可能不对`);
  const missing = [...used].filter(([key]) => !baseKeys.has(key)).map(([key, file]) => `${key}（${file}）`);
  assert.deepEqual(missing, []);
});

test("HTML 里 data-i18n 那几处先写着的英文和 en.mjs 一字不差（页面加载完之前、读屏软件看到的就是它）", () => {
  const root = resolve(import.meta.dirname, "../..");
  const decode = (text) => text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  let checked = 0;
  for (const file of sourceFiles(join(root, "src")).filter((path) => path.endsWith(".html"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/data-i18n="([\w.]+)"[^<>]*>([^<]*)</g)) {
      const fallback = baseKeys.get(match[1]);
      assert.equal(decode(match[2]), isPlural(fallback) ? fallback.other : fallback, `${file}：${match[1]}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `只查到 ${checked} 处`);
});
