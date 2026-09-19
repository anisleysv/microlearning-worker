import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

test("local client sends authenticated prompt, saves JPEG and refuses overwrite", async () => {
  const image = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      url: req.url, auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(image);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = fileURLToPath(new URL("../.local-review/", import.meta.url));
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, "client-test-"));
  const path = join(temp, "image.jpg");
  async function runClient() {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../scripts/generate.mjs", import.meta.url)), "Imagen educativa", path,
    ], {
      env: { ...process.env, WORKER_URL: `http://127.0.0.1:${server.address().port}`,
        IMAGE_API_KEY: "test-client-key" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const [code] = await once(child, "close");
    return { code, stderr };
  }
  try {
    assert.equal((await runClient()).code, 0);
    assert.deepEqual(await readFile(path), image);
    assert.deepEqual(requests[0], {
      url: "/api/images", auth: "Bearer test-client-key",
      body: { prompt: "Imagen educativa", steps: 4, format: "jpeg" },
    });
    const second = await runClient();
    assert.equal(second.code, 1);
    assert.match(second.stderr, /EEXIST/);
    assert.equal(requests.length, 1);
    assert.deepEqual(await readFile(path), image);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
