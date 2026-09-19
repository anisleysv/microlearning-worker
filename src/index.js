const MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MAX_BODY_BYTES = 16 * 1024;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonError(status, message, headers, extra = {}) {
  return Response.json({ error: message }, {
    status, headers: { ...headers, ...extra },
  });
}

async function authorized(request, secret) {
  const value = request.headers.get("Authorization") || "";
  if (!value.startsWith("Bearer ") || value.length > 1024) return false;
  // Hash both values before comparison so the loop always has a fixed length.
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all(
    [value.slice(7), secret].map((text) =>
      crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  const a = new Uint8Array(actual);
  const b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function readInput(request) {
  const type = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new RequestError(415, "Content-Type debe ser application/json.");
  }
  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) {
    throw new RequestError(413, "El cuerpo supera 16 KiB.");
  }
  // Enforce the byte limit even when Content-Length is absent or inaccurate.
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "Se requiere un cuerpo JSON.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(413, "El cuerpo supera 16 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let input;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "JSON inválido.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RequestError(400, "Se requiere un objeto JSON.");
  }
  if (Object.keys(input).some((key) => !["prompt", "steps", "format"].includes(key))) {
    throw new RequestError(400, "Solo se admiten prompt, steps y format.");
  }
  if (typeof input.prompt !== "string") {
    throw new RequestError(400, "prompt debe ser texto.");
  }
  const prompt = input.prompt.trim();
  if (!prompt || Array.from(prompt).length > 2048) {
    throw new RequestError(400, "prompt debe contener entre 1 y 2048 caracteres.");
  }
  const steps = input.steps === undefined ? 4 : input.steps;
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
    throw new RequestError(400, "steps debe ser un entero entre 1 y 8.");
  }
  const format = input.format === undefined ? "jpeg" : input.format;
  if (!["jpeg", "json"].includes(format)) {
    throw new RequestError(400, "format debe ser jpeg o json.");
  }
  return { prompt, steps, format };
}

export default {
  async fetch(request, env) {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (origin && !allowed.includes(origin)) {
      return jsonError(403, "Origen no autorizado.", headers);
    }
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", service: "microlearning-worker" }, { headers });
    }
    if (path !== "/api/images") return jsonError(404, "Ruta no encontrada.", headers);
    if (request.method === "OPTIONS") {
      const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") || "")
        .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!origin || request.headers.get("Access-Control-Request-Method") !== "POST" ||
          requestedHeaders.some((x) => !["authorization", "content-type"].includes(x))) {
        return jsonError(403, "Preflight no autorizado.", headers);
      }
      return new Response(null, { status: 204, headers: {
        ...headers,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      } });
    }
    if (request.method !== "POST") {
      return jsonError(405, "Usa POST para generar imágenes.", headers, { Allow: "POST, OPTIONS" });
    }
    // Fail closed until a non-placeholder application secret is configured.
    if (typeof env.IMAGE_API_KEY !== "string" || env.IMAGE_API_KEY.trim().length < 32) {
      return jsonError(503, "El servicio necesita configuración.", headers);
    }
    if (!await authorized(request, env.IMAGE_API_KEY)) {
      return jsonError(401, "Credencial inválida o ausente.", headers, {
        "WWW-Authenticate": "Bearer",
      });
    }
    let input;
    try {
      input = await readInput(request);
    } catch (error) {
      if (error instanceof RequestError) return jsonError(error.status, error.message, headers);
      return jsonError(400, "No se pudo leer la solicitud.", headers);
    }
    if (typeof env.AI?.run !== "function") {
      return jsonError(503, "Workers AI no está configurado.", headers);
    }
    try {
      const result = await env.AI.run(MODEL, { prompt: input.prompt, steps: input.steps });
      if (typeof result?.image !== "string" || !result.image) throw new Error("Missing image");
      const image = Uint8Array.from(atob(result.image), (character) => character.charCodeAt(0));
      if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
        throw new Error("Invalid JPEG response");
      }
      if (input.format === "json") {
        return Response.json({ model: MODEL, mimeType: "image/jpeg", image: result.image }, { headers });
      }
      return new Response(image, { headers: {
        ...headers, "Content-Type": "image/jpeg",
        "Content-Disposition": 'inline; filename="microlearning-image.jpg"',
      } });
    } catch (error) {
      // Never expose provider messages, prompts or credentials; never retry paid work automatically.
      if (error?.status === 429 || error?.statusCode === 429) {
        return jsonError(429, "Cuota o límite temporal de IA alcanzado. Inténtalo más tarde.", headers);
      }
      return jsonError(502, "Workers AI no pudo generar una imagen válida.", headers);
    }
  },
};
