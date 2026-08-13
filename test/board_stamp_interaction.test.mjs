import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const OFFICIAL_STAMPS = ["☕", "✦", "🌙", "🍰", "💗", "🎧", "🎀", "🍾"];
const editor = fs.readFileSync(new URL("../eruremo_SiteManager.html", import.meta.url), "utf8");
const encoded = /const TEMPLATE = decodeB64\("([^"]+)"\)/u.exec(editor)?.[1];
assert.ok(encoded, "TEMPLATE is embedded");
const template = Buffer.from(encoded, "base64").toString("utf8");
const scriptStart = template.indexOf('(function(){\n  const elPosts=$("#posts")');
const scriptEnd = template.indexOf("\n})();", scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "board runtime is extractable");
const boardRuntime = template.slice(scriptStart, scriptEnd + 6);

class FakeElement {
  constructor(tag = "div", text = "") {
    this.tagName = tag.toUpperCase();
    this.textContent = text ?? "";
    this.value = "";
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = { toggle() {}, remove() {} };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  querySelectorAll(selector) { return selector === "button" ? this.children.filter((child) => child.tagName === "BUTTON") : []; }
  async click() {
    if (this.disabled) return false;
    for (const listener of this.listeners.get("click") ?? []) await listener({ currentTarget: this });
    return true;
  }
  focus() {}
}

async function makeBoard(responseForPost = async () => ({ status: 201, body: { ok: true, post: {} } })) {
  const ids = ["posts", "bName", "bText", "bCount", "bSend", "bMsg", "bEmpty", "bStamp", "bReload", "bTurnstile"];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id === "bSend" || id === "bReload" ? "button" : "div")]));
  const posts = [];
  let getCount = 0;
  let resetCount = 0;
  let turnstileCallback = null;
  const context = {
    D: { board: { turnstileSiteKey: "public-test-key", ngWords: [] } },
    $: (selector) => elements[selector.slice(1)] ?? null,
    el: (tag, className, text) => new FakeElement(tag, text),
    txt: (value) => String(value ?? ""),
    document: {
      createDocumentFragment: () => new FakeElement("fragment"),
      createElement: (tag) => new FakeElement(tag),
      head: new FakeElement("head"),
    },
    window: {
      turnstile: {
        render(_element, options) { turnstileCallback = options.callback; return 7; },
        reset() { resetCount += 1; },
      },
    },
    fetch: async (_url, options = {}) => {
      if (options.method === "POST") {
        const payload = JSON.parse(options.body);
        posts.push({ payload, sendDisabledDuringFetch: elements.bSend.disabled });
        const result = await responseForPost(payload, posts.length);
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      getCount += 1;
      return new Response(JSON.stringify({ ok: true, posts: [] }), { headers: { "content-type": "application/json" } });
    },
    Response,
    Intl,
    Date,
    console,
  };
  vm.runInNewContext(boardRuntime, context, { filename: "generated-board-runtime.js" });
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, posts, get getCount() { return getCount; }, get resetCount() { return resetCount; }, verify: (token) => turnstileCallback(token) };
}

test("all eight stamp buttons keep text, data-stamp, aria-label, selection, and POST payload identical", async () => {
  const board = await makeBoard();
  const buttons = board.elements.bStamp.querySelectorAll("button");
  assert.equal(buttons.length, OFFICIAL_STAMPS.length);
  for (const [index, stamp] of OFFICIAL_STAMPS.entries()) {
    const button = buttons[index];
    assert.equal(button.textContent, stamp);
    assert.equal(button.dataset.stamp, stamp);
    assert.equal(button.getAttribute("aria-label"), `スタンプ ${stamp}`);
    await button.click();
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(buttons.filter((item) => item.getAttribute("aria-pressed") === "true").length, 1);
    board.elements.bText.value = `message-${index}`;
    board.verify(`fresh-token-${index}`);
    assert.equal(await board.elements.bSend.click(), true);
    assert.equal(board.posts.at(-1).payload.stamp, stamp);
  }
  assert.deepEqual(board.posts.map((item) => item.payload.stamp), OFFICIAL_STAMPS);
});

test("star button posts U+2726 and never substitutes U+2728", async () => {
  const board = await makeBoard();
  const star = board.elements.bStamp.querySelectorAll("button")[1];
  await star.click();
  board.elements.bText.value = "star";
  board.verify("fresh-token");
  await board.elements.bSend.click();
  const stamp = board.posts[0].payload.stamp;
  assert.equal(stamp, "✦");
  assert.equal(stamp.codePointAt(0), 0x2726);
  assert.notEqual(stamp, "✨");
  assert.notEqual(stamp.codePointAt(0), 0x2728);
});

test("BAD_REQUEST keeps input, shows input error, resets Turnstile, and requires a fresh token", async () => {
  const board = await makeBoard(async () => ({ status: 400, body: { ok: false, error: { code: "BAD_REQUEST", message: "invalid" } } }));
  board.elements.bText.value = "keep this text";
  board.verify("first-token");
  await board.elements.bSend.click();
  assert.equal(board.elements.bText.value, "keep this text");
  assert.equal(board.elements.bMsg.textContent, "入力内容を確認して、もう一度お試しください");
  assert.equal(board.resetCount, 1);
  assert.equal(board.elements.bSend.disabled, true);
  assert.equal(await board.elements.bSend.click(), false);
  assert.equal(board.posts.length, 1);
  board.verify("second-token");
  assert.equal(board.elements.bSend.disabled, false);
});

test("successful post disables while pending, clears only after 201, resets widget, and reloads list", async () => {
  const board = await makeBoard();
  board.elements.bText.value = "clear after success";
  board.verify("fresh-token");
  const getBefore = board.getCount;
  await board.elements.bSend.click();
  assert.equal(board.posts[0].sendDisabledDuringFetch, true);
  assert.equal(board.elements.bText.value, "");
  assert.equal(board.resetCount, 1);
  assert.equal(board.getCount, getBefore + 1);
});
