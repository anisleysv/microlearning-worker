import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

const key = "test-only-not-a-real-secret-0123456789";
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
function setup(overrides = {}) {
  const calls = [];
  const env = { IMAGE_API_KEY: key, ALLOWED_ORIGINS: "",
    AI: { run: async (...args) => { calls.push(args); return { image: jpeg.toString("base64") }; } },
    ...overrides };
  return { env, calls };
}
function request(body = { prompt: "Un diagrama educativo" }, options = {}) {
  const { headers, ...rest } = options;
  return new Request("https://worker.example/api/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...rest,
  });
}

test("returns JPEG and passes only supported model inputs", async () => {
  const { env, calls } = setup();
  const response = await worker.fetch(request({ prompt: "  Hola  " }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  assert.deepEqual(calls, [[MODEL, { prompt: "Hola", steps: 4 }]]);
});
test("returns documented base64 JSON format", async () => {
  const { env } = setup();
  const response = await worker.fetch(request({ prompt: "Hola", steps: 8, format: "json" }), env);
  assert.deepEqual(await response.json(), { model: MODEL, mimeType: "image/jpeg", image: jpeg.toString("base64") });
});
for (const [label, value] of [
  ["empty", ""], ["wrong", "Bearer wrong"], ["wrong scheme", `Basic ${key}`],
]) {
  test(`rejects ${label} credentials before calling AI`, async () => {
    const { env, calls } = setup();
    const response = await worker.fetch(request(undefined, { headers: { Authorization: value } }), env);
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
}
for (const secret of [undefined, "", "short", " ".repeat(40)]) {
  test(`fails closed for invalid secret ${JSON.stringify(secret)}`, async () => {
    const { env, calls } = setup({ IMAGE_API_KEY: secret });
    assert.equal((await worker.fetch(request(), env)).status, 503);
    assert.equal(calls.length, 0);
  });
}
for (const body of [
  null, [], {}, { prompt: 1 }, { prompt: " " }, { prompt: "x".repeat(2049) },
  { prompt: "ok", steps: 0 }, { prompt: "ok", steps: 9 },
  { prompt: "ok", steps: 1.5 }, { prompt: "ok", steps: "4" },
  { prompt: "ok", format: "png" }, { prompt: "ok", model: "other" },
]) {
  test(`rejects invalid input ${JSON.stringify(body).slice(0, 75)}`, async () => {
    const { env, calls } = setup();
    assert.equal((await worker.fetch(request(body), env)).status, 400);
    assert.equal(calls.length, 0);
  });
}
test("accepts 2048 Unicode characters and steps=1", async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(request({ prompt: "🎨".repeat(2048), steps: 1 }), env)).status, 200);
});
test("rejects malformed JSON", async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(request(undefined, { body: "{" }), env)).status, 400);
});
test("rejects unsupported content type", async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(request(undefined, { headers: { "Content-Type": "text/plain" } }), env)).status, 415);
});
test("limits streamed bodies even without Content-Length", async () => {
  const { env, calls } = setup();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(17 * 1024)); controller.close();
  } });
  const response = await worker.fetch(request(undefined, { body, duplex: "half" }), env);
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});
test("rejects declared oversized body", async () => {
  const { env } = setup();
  assert.equal((await worker.fetch(request(undefined, { headers: { "Content-Length": "20000" } }), env)).status, 413);
});
test("blocks browsers by default, even with a valid key", async () => {
  const { env, calls } = setup();
  const response = await worker.fetch(request(undefined, { headers: { Origin: "https://example.com" } }), env);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(calls.length, 0);
});
test("allows an exact configured origin but still requires auth", async () => {
  const { env } = setup({ ALLOWED_ORIGINS: "https://example.com" });
  const response = await worker.fetch(request(undefined, {
    headers: { Origin: "https://example.com", Authorization: "" },
  }), env);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
  assert.equal((await worker.fetch(request(undefined, {
    headers: { Origin: "https://example.com.evil.test" },
  }), env)).status, 403);
});
test("valid CORS preflight does not run the model", async () => {
  const { env, calls } = setup({ ALLOWED_ORIGINS: "https://example.com" });
  const req = request(undefined, { method: "OPTIONS", body: undefined, headers: {
    Origin: "https://example.com",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type",
  } });
  assert.equal((await worker.fetch(req, env)).status, 204);
  assert.equal(calls.length, 0);
});
test("invalid preflight is rejected", async () => {
  const { env } = setup({ ALLOWED_ORIGINS: "https://example.com" });
  const req = request(undefined, { method: "OPTIONS", body: undefined, headers: {
    Origin: "https://example.com", "Access-Control-Request-Method": "DELETE",
  } });
  assert.equal((await worker.fetch(req, env)).status, 403);
});
test("health is liveness only; no AI invocation", async () => {
  const { env, calls } = setup();
  const response = await worker.fetch(new Request("https://worker.example/health"), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  assert.equal(calls.length, 0);
});
test("unknown route and unsupported method do not generate", async () => {
  const { env, calls } = setup();
  assert.equal((await worker.fetch(new Request("https://worker.example/unknown"), env)).status, 404);
  const response = await worker.fetch(new Request("https://worker.example/api/images"), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST, OPTIONS");
  assert.equal(calls.length, 0);
});
test("missing AI binding reports configuration issue", async () => {
  const { env } = setup({ AI: undefined });
  assert.equal((await worker.fetch(request(), env)).status, 503);
});
test("provider errors are redacted and never retried", async () => {
  let calls = 0;
  const { env } = setup({ AI: { run: async () => { calls++; throw new Error("PRIVATE PROVIDER DETAILS"); } } });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("PRIVATE"));
  assert.equal(calls, 1);
});
test("preserves provider 429 when the binding exposes HTTP status", async () => {
  const { env } = setup({ AI: { run: async () => { throw Object.assign(new Error("quota"), { status: 429 }); } } });
  assert.equal((await worker.fetch(request(), env)).status, 429);
});
for (const result of [{}, { image: "invalid!" }, { image: btoa("not an image") }]) {
  test(`rejects malformed model output ${JSON.stringify(result)}`, async () => {
    const { env } = setup({ AI: { run: async () => result } });
    assert.equal((await worker.fetch(request(), env)).status, 502);
  });
}
