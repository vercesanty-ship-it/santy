import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export const config = { path: "/api/edit-video" };

const REPLICATE_API = "https://api.replicate.com/v1";
const WHISPER_MODEL = "openai/whisper"; // input: audio (url o base64) -> { text, segments: [{start,end,text}] }
// Límite de v1: procesar video en una función serverless tiene techo de
// tiempo (15 min) y memoria/disco — por ahora restringimos la duración para
// no pasarnos. Se puede subir más adelante si migramos a un worker aparte.
const MAX_DURATION_SECONDS = 180;
const SILENCE_NOISE_DB = "-30dB";
const SILENCE_MIN_DURATION = 0.5;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} salió con código ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function parseDuration(ffmpegStderr) {
  const m = ffmpegStderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseSilences(stderr) {
  const silences = [];
  const startRe = /silence_start:\s*([\d.]+)/g;
  const endRe = /silence_end:\s*([\d.]+)/g;
  const starts = [...stderr.matchAll(startRe)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(endRe)].map((m) => Number(m[1]));
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    silences.push({ start: starts[i], end: ends[i] });
  }
  return silences;
}

function buildKeepExpr(silences) {
  // "quedate con todo lo que NO esté dentro de ninguna de estas ventanas de silencio"
  const terms = silences.map((s) => `between(t,${s.start},${s.end})`).join("+");
  return `not(${terms})`;
}

function srtTimestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

function buildSrt(segments) {
  return segments
    .map((seg, i) => `${i + 1}\n${srtTimestamp(seg.start)} --> ${srtTimestamp(seg.end)}\n${seg.text.trim()}\n`)
    .join("\n");
}

// Normaliza distintas formas de respuesta que puede devolver un modelo de
// Whisper en Replicate (varían según la versión/wrapper).
function extractTranscriptSegments(output) {
  const segments = output?.segments || output?.chunks;
  if (Array.isArray(segments) && segments.length > 0) {
    return segments
      .map((seg) => {
        if (Array.isArray(seg.timestamp)) {
          return { start: seg.timestamp[0], end: seg.timestamp[1] ?? seg.timestamp[0] + 2, text: seg.text };
        }
        return { start: seg.start, end: seg.end, text: seg.text };
      })
      .filter((s) => typeof s.start === "number" && typeof s.end === "number" && s.text);
  }
  return null;
}

function extractFullText(output) {
  return output?.text || output?.transcription || "";
}

async function resolveLatestVersion(model, token) {
  const res = await fetch(`${REPLICATE_API}/models/${model}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok || !data?.latest_version?.id) {
    throw new Error(`Replicate (${model}): no pudimos resolver la versión (${data?.detail || res.statusText}).`);
  }
  return data.latest_version.id;
}

async function replicatePredict(model, input, token) {
  const version = await resolveLatestVersion(model, token);
  const createRes = await fetch(`${REPLICATE_API}/predictions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: "wait" },
    body: JSON.stringify({ version, input }),
  });
  let prediction = await createRes.json();
  if (!createRes.ok) throw new Error(`Replicate (${model}): ${prediction?.detail || createRes.statusText}`);

  let attempts = 0;
  while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
    if (attempts++ > 150) throw new Error(`Replicate (${model}): tardó demasiado.`);
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${REPLICATE_API}/predictions/${prediction.id}`, { headers: { Authorization: `Bearer ${token}` } });
    prediction = await pollRes.json();
  }
  if (prediction.status !== "succeeded") throw new Error(`Replicate (${model}) falló: ${prediction.error || "error desconocido"}`);
  return prediction.output;
}

async function generateCaption(transcriptText, anthropicKey) {
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const msg = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 400,
    messages: [{
      role: "user",
      content: `Este es el texto hablado de un video para Instagram Reels:\n\n"""${transcriptText.slice(0, 3000)}"""\n\nEscribí, en español y en JSON válido (sin markdown alrededor), una descripción atractiva para el post de Instagram y una lista de 8 a 12 hashtags relevantes (sin el símbolo #, solo la palabra). Formato exacto:\n{"caption": "...", "hashtags": ["...", "..."]}`,
    }],
  });
  const text = msg.content?.[0]?.text || "{}";
  try {
    const parsed = JSON.parse(text);
    return { caption: parsed.caption || "", hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [] };
  } catch {
    return { caption: text, hashtags: [] };
  }
}

export default async (req) => {
  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const replicateToken = Netlify.env.get("REPLICATE_API_TOKEN");
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");

  let jobId, kind;
  try {
    ({ jobId, kind } = await req.json());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const table = kind === "trial_jobs" ? "trial_jobs" : "video_jobs";
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "reelizate-"));

  try {
    const { data: job, error: jobErr } = await supabase.from(table).select("*").eq("id", jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message || "Trabajo no encontrado.");

    if (table === "video_jobs") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: userData } = await supabase.auth.getUser(token);
      if (!userData?.user || userData.user.id !== job.user_id) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // 1) Descargar el original a /tmp
    const { data: fileBlob, error: dlErr } = await supabase.storage.from("reel-files").download(job.input_path);
    if (dlErr) throw new Error(`No se pudo descargar el video: ${dlErr.message}`);
    const inputPath = path.join(workDir, "input.mp4");
    await fs.writeFile(inputPath, Buffer.from(await fileBlob.arrayBuffer()));

    // 2) Duración y silencios
    const probeStderr = await run(ffmpegPath, ["-i", inputPath, "-f", "null", "-"]).catch((e) => e.message);
    const duration = parseDuration(probeStderr) || 0;
    if (duration > MAX_DURATION_SECONDS) {
      throw new Error(`El video dura ${Math.round(duration)}s — por ahora el máximo es ${MAX_DURATION_SECONDS}s (${MAX_DURATION_SECONDS / 60} min).`);
    }

    const silenceStderr = await run(ffmpegPath, [
      "-i", inputPath, "-af", `silencedetect=noise=${SILENCE_NOISE_DB}:d=${SILENCE_MIN_DURATION}`, "-f", "null", "-",
    ]).catch((e) => e.message);
    const silences = parseSilences(silenceStderr);

    const cutPath = path.join(workDir, "cut.mp4");
    if (silences.length > 0) {
      const keepExpr = buildKeepExpr(silences);
      await run(ffmpegPath, [
        "-y", "-i", inputPath,
        "-vf", `select='${keepExpr}',setpts=N/FRAME_RATE/TB`,
        "-af", `aselect='${keepExpr}',asetpts=N/SR/TB`,
        "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", cutPath,
      ]);
    } else {
      await fs.copyFile(inputPath, cutPath);
    }

    // 3) Subimos el video ya cortado (temporalmente) para transcribirlo con
    // la misma línea de tiempo que va a tener el resultado final.
    const tempCutStoragePath = `${job.user_id ? job.user_id + "/" : "trial/"}tmp/${job.id}-cut.mp4`;
    const cutBuffer = await fs.readFile(cutPath);
    await supabase.storage.from("reel-files").upload(tempCutStoragePath, cutBuffer, { contentType: "video/mp4", upsert: true });
    const { data: signedCut } = await supabase.storage.from("reel-files").createSignedUrl(tempCutStoragePath, 3600);

    let transcriptText = "";
    let segments = null;
    try {
      const whisperOutput = await replicatePredict(WHISPER_MODEL, { audio: signedCut.signedUrl }, replicateToken);
      transcriptText = extractFullText(whisperOutput);
      segments = extractTranscriptSegments(whisperOutput);
    } catch (whisperErr) {
      // Si falla la transcripción, seguimos igual: entregamos el video
      // editado sin subtítulos ni descripción generada, en vez de fallar
      // todo el trabajo.
      console.error("edit-video: transcripción falló:", whisperErr.message);
    }

    // 4) Subtítulos quemados + color, si tenemos segmentos con timing
    const finalPath = path.join(workDir, "final.mp4");
    if (segments && segments.length > 0) {
      const srtPath = path.join(workDir, "subs.srt");
      await fs.writeFile(srtPath, buildSrt(segments));
      const style = "FontName=DejaVu Sans,FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=60";
      await run(ffmpegPath, [
        "-y", "-i", cutPath,
        "-vf", `eq=contrast=1.08:saturation=1.15:brightness=0.02,subtitles=${srtPath}:force_style='${style}'`,
        "-c:v", "libx264", "-c:a", "copy", "-pix_fmt", "yuv420p", finalPath,
      ]);
    } else {
      await run(ffmpegPath, [
        "-y", "-i", cutPath,
        "-vf", "eq=contrast=1.08:saturation=1.15:brightness=0.02",
        "-c:v", "libx264", "-c:a", "copy", "-pix_fmt", "yuv420p", finalPath,
      ]);
    }

    // 5) Descripción + hashtags para Instagram
    let caption = "";
    let hashtags = [];
    if (transcriptText) {
      try {
        const gen = await generateCaption(transcriptText, anthropicKey);
        caption = gen.caption;
        hashtags = gen.hashtags;
      } catch (capErr) {
        console.error("edit-video: generación de descripción falló:", capErr.message);
      }
    }

    // 6) Subir resultado final y limpiar el temporal
    const resultPath = job.input_path.replace(/\.(mp4|mov)$/i, "") + "-editado.mp4";
    const finalBuffer = await fs.readFile(finalPath);
    const { error: upErr } = await supabase.storage.from("reel-files").upload(resultPath, finalBuffer, { contentType: "video/mp4", upsert: true });
    if (upErr) throw new Error(`No se pudo guardar el video editado: ${upErr.message}`);
    await supabase.storage.from("reel-files").remove([tempCutStoragePath]);

    await supabase.from(table).update({
      status: "done",
      result_path: resultPath,
      transcript: transcriptText || null,
      caption,
      hashtags,
      report: {
        duracion_original_s: Math.round(duration),
        silencios_cortados: silences.length,
        subtitulos: !!(segments && segments.length > 0),
      },
    }).eq("id", job.id);
  } catch (err) {
    await supabase.from(table).update({ status: "failed", report: { error: err?.message || String(err) } }).eq("id", jobId);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  return new Response("ok", { status: 200 });
};
