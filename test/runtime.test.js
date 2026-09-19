import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";

test("Cloudflare runtime: health, authentication and missing AI configuration", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    compatibilityDate: "2026-09-19",
    bindings: { IMAGE_API_KEY: "test-only-runtime-secret-0123456789" },
  }));
  try {
    const health = await mf.dispatchFetch("http://localhost/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const unauthorized = await mf.dispatchFetch("http://localhost/api/images", {
      method: "POST", body: JSON.stringify({ prompt: "Hola" }),
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(unauthorized.status, 401);
    const missingBinding = await mf.dispatchFetch("http://localhost/api/images", {
      method: "POST", body: JSON.stringify({ prompt: "Hola" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-only-runtime-secret-0123456789",
      },
    });
    assert.equal(missingBinding.status, 503);
  } finally {
    await mf.dispose();
  }
});
