import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_VENDORS } from "../../src/server/chat/vendors.mjs";
import { PROVIDERS } from "../../src/server/providers/index.mjs";
import { findVendor, VENDORS } from "../../src/server/vendors.mjs";

test("要给 key 的每一家：两条链路的都在，同一家只出现一次", () => {
  const ids = VENDORS.map(({ id }) => id);
  assert.deepEqual(ids, [...new Set([...PROVIDERS, ...CHAT_VENDORS].map(({ id }) => id))]);
  for (const vendor of VENDORS) {
    assert.ok(vendor.name && vendor.keyEnv, vendor.id);
  }
});

test("按 id 找，大小写不论；不认识的是 null", () => {
  assert.equal(findVendor("DeepSeek").keyEnv, "DEEPSEEK_API_KEY");
  assert.equal(findVendor("gemini").keyEnv, "GEMINI_API_KEY");
  assert.equal(findVendor("custom").keyPage, null);
  assert.equal(findVendor("nobody"), null);
});
