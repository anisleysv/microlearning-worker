import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [prompt, destination = "output/image.jpg"] = process.argv.slice(2);
const secret = process.env.IMAGE_API_KEY;
const workerUrl = process.env.WORKER_URL || "http://127.0.0.1:8787";
try {
  if (!prompt?.trim() || !secret) {
    throw new Error('Uso: node scripts/generate.mjs "Descripción" [salida.jpg]. Configura IMAGE_API_KEY y WORKER_URL.');
  }
  const url = new URL("/api/images", workerUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("Usa HTTPS, salvo en localhost.");
  }
  const path = resolve(destination);
  try {
    await lstat(path);
    throw new Error("EEXIST: elige otro nombre de salida antes de generar.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, steps: 4, format: "jpeg" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`El Worker respondió HTTP ${response.status}. ${await response.text()}`);
  }
  if (response.headers.get("content-type")?.split(";")[0] !== "image/jpeg") {
    throw new Error("El servidor no devolvió una imagen JPEG.");
  }
  await mkdir(dirname(path), { recursive: true });
  // Refuse to overwrite an existing user file.
  await writeFile(path, new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
  console.log(`Imagen guardada: ${path}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
