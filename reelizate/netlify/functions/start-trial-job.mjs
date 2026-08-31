import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

export const config = { path: "/api/start-trial-job" };

// No guardamos la IP en texto plano: un hash alcanza para el límite de
// "1 video gratis por IP" sin retener el dato en sí.
function hashIp(ip) {
  const salt = Netlify.env.get("IP_HASH_SALT") || "reelizate";
  return crypto.createHash("sha256").update(salt + ip).digest("hex");
}

function getClientIp(req) {
  // Netlify agrega esta cabecera con la IP real del visitante.
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad request" }), { status: 400 });
  }
  const { originalFilename, inputPath } = body;
  if (!inputPath) {
    return new Response(JSON.stringify({ error: "Falta el archivo subido." }), { status: 400 });
  }

  const ipHash = hashIp(getClientIp(req));

  const { count } = await supabase
    .from("trial_jobs")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash);

  if ((count || 0) > 0) {
    return new Response(JSON.stringify({ error: "Ya usaste tu video de muestra gratis desde esta conexión." }), { status: 429 });
  }

  const { data: job, error: jobErr } = await supabase
    .from("trial_jobs")
    .insert({ ip_hash: ipHash, original_filename: originalFilename, input_path: inputPath, status: "processing" })
    .select()
    .single();
  if (jobErr) {
    return new Response(JSON.stringify({ error: jobErr.message }), { status: 500 });
  }

  // Dispara el procesamiento en segundo plano (no esperamos la respuesta).
  const siteUrl = Netlify.env.get("URL") || `https://${req.headers.get("host")}`;
  fetch(`${siteUrl}/api/edit-video`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id, kind: "trial_jobs" }),
  }).catch(() => {});

  return new Response(JSON.stringify({ jobId: job.id }), { status: 200, headers: { "content-type": "application/json" } });
};
