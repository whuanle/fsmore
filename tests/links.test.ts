import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFeishuLink } from "../src/feishu/tree.js";
import { sanitizeFilename } from "../src/workspace/store.js";

test("解析 wiki 链接", () => {
  const parsed = parseFeishuLink("https://xxx.feishu.cn/wiki/Q6ERw1abcXYZ123");
  assert.equal(parsed.token, "Q6ERw1abcXYZ123");
  assert.equal(parsed.kindGuess, "wiki");
  assert.equal(parsed.domain, "xxx.feishu.cn");
});

test("解析 docx 链接", () => {
  const parsed = parseFeishuLink("https://xxx.feishu.cn/docx/DOCNabcdef123456");
  assert.equal(parsed.token, "DOCNabcdef123456");
  assert.equal(parsed.kindGuess, "doc");
});

test("解析 folder 链接", () => {
  const parsed = parseFeishuLink("https://xxx.feishu.cn/folder/fldcnABC123");
  assert.equal(parsed.token, "fldcnABC123");
  assert.equal(parsed.kindGuess, "folder");
});

test("解析裸 token", () => {
  assert.equal(parseFeishuLink("wikcnABC123").kindGuess, "wiki");
  assert.equal(parseFeishuLink("fldcnABC123").kindGuess, "folder");
  assert.equal(parseFeishuLink("DOCNABC123").kindGuess, "doc");
});

test("非法输入抛出错误", () => {
  assert.throws(() => parseFeishuLink("https://example.com/other/xxx"));
  assert.throws(() => parseFeishuLink("hello world!"));
});

test("文件名清洗", () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(sanitizeFilename("  ..隐藏标题  "), "隐藏标题");
  assert.equal(sanitizeFilename(""), "untitled");
  const long = "长".repeat(200);
  assert.ok(sanitizeFilename(long).length <= 80);
});
