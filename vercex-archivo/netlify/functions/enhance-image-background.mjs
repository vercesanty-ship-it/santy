import { createClient } from "@supabase/supabase-js";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import sharp from "sharp";
import zlib from "zlib";

export const config = { path: "/api/enhance-image" };

const REPLICATE_API = "https://api.replicate.com/v1";
// Modelos públicos y estables de Replicate. Los nombres de sus inputs están
// tomados de su documentación pública — conviene confirmarlos una vez en el
// playground de Replicate antes de ir a producción, ya que no pude
// verificarlos en vivo desde acá.
const UPSCALE_MODEL = "nightmareai/real-esrgan"; // input: image, scale, face_enhance
const BG_REMOVE_MODEL = "cjwbw/rembg"; // input: image
const PRINT_DPI = 300;

async function replicatePredict(model, input, token) {
  const createRes = await fetch(`${REPLICATE_API}/models/${model}/predictions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: "wait" },
    body: JSON.stringify({ input }),
  });
  let prediction = await createRes.json();
  if (!createRes.ok) throw new Error(`Replicate (${model}): ${prediction?.detail || createRes.statusText}`);

  let attempts = 0;
  while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
    if (attempts++ > 150) throw new Error(`Replicate (${model}): tardó demasiado.`);
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${REPLICATE_API}/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    prediction = await pollRes.json();
  }
  if (prediction.status !== "succeeded") {
    throw new Error(`Replicate (${model}) falló: ${prediction.error || "error desconocido"}`);
  }
  const out = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
  if (!out) throw new Error(`Replicate (${model}) no devolvió resultado.`);
  return out;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar el resultado (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

const CHANNELS_BY_COLORSPACE = { "/DeviceRGB": 3, "/DeviceGray": 1, "/DeviceCMYK": 4 };

// Extrae la primera imagen embebida de un PDF de una sola página (el caso
// típico de los archivos de diseño que pasan por "Revisar y corregir").
// Soporta JPEG embebido tal cual (DCTDecode) y píxeles crudos sin
// predictor (FlateDecode) — es la codificación que generan tanto pdf-lib
// como la mayoría de los exportadores de diseño para imágenes simples.
async function extractFirstImageFromPdf(pdfBytes) {
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  for (const page of pdfDoc.getPages()) {
    const xObjects = page.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    if (!xObjects) continue;
    for (const key of xObjects.keys()) {
      const xObject = xObjects.lookup(key);
      const subtype = xObject?.dict?.get?.(PDFName.of("Subtype"));
      if (!subtype || subtype.toString() !== "/Image") continue;

      const filter = xObject.dict.get(PDFName.of("Filter"))?.toString();
      if (filter === "/DCTDecode") {
        return Buffer.from(xObject.contents); // ya es un JPEG válido
      }
      if (filter === "/FlateDecode") {
        const w = xObject.dict.get(PDFName.of("Width"))?.asNumber();
        const h = xObject.dict.get(PDFName.of("Height"))?.asNumber();
        const colorSpace = xObject.dict.get(PDFName.of("ColorSpace"))?.toString();
        const channels = CHANNELS_BY_COLORSPACE[colorSpace];
        if (w && h && channels) {
          const raw = zlib.inflateSync(Buffer.from(xObject.contents));
          if (raw.length === w * h * channels) {
            return await sharp(raw, { raw: { width: w, height: h, channels } }).png().toBuffer();
          }
        }
      }
    }
  }
  throw new Error("No encontramos una imagen dentro del PDF que pudiéramos mejorar con IA.");
}

export default async (req) => {
  const supabase = createClient(
    Netlify.env.get("SUPABASE_URL"),
    Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );
  const replicateToken = Netlify.env.get("REPLICATE_API_TOKEN");

  let jobId;
  try {
    ({ jobId } = await req.json());
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  try {
    const { data: job, error: jobErr } = await supabase
      .from("print_jobs")
      .select("*")
      .eq("id", jobId)
      .single();
    if (jobErr || !job) throw new Error(jobErr?.message || "Trabajo no encontrado.");

    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData } = await supabase.auth.getUser(token);
    if (!userData?.user || userData.user.id !== job.user_id) {
      return new Response("Forbidden", { status: 403 });
    }

    await supabase.from("print_jobs").update({ enhanced_status: "processing" }).eq("id", job.id);

    let beforeBuffer;
    if (job.job_type === "enhance") {
      const { data: fileBlob, error: dlErr } = await supabase.storage
        .from("print-files")
        .download(job.original_path);
      if (dlErr) throw new Error(`No se pudo descargar la imagen: ${dlErr.message}`);
      beforeBuffer = Buffer.from(await fileBlob.arrayBuffer());
    } else {
      // job_type "check": mejora la imagen del archivo ya corregido (o el
      // original si todavía no se corrigió).
      const pdfPath = job.result_path || job.original_path;
      const { data: fileBlob, error: dlErr } = await supabase.storage.from("print-files").download(pdfPath);
      if (dlErr) throw new Error(`No se pudo descargar el PDF: ${dlErr.message}`);
      beforeBuffer = await extractFirstImageFromPdf(new Uint8Array(await fileBlob.arrayBuffer()));
    }

    const beforeMeta = await sharp(beforeBuffer).metadata();
    const beforePng = await sharp(beforeBuffer).png().toBuffer();
    const beforePath = `${job.user_id}/enhance/${job.id}-before.png`;
    const { error: beforeUpErr } = await supabase.storage
      .from("print-files")
      .upload(beforePath, beforePng, { contentType: "image/png", upsert: true });
    if (beforeUpErr) throw new Error(`No se pudo guardar la imagen original: ${beforeUpErr.message}`);

    // 1) Mejora nitidez/detalle (upscale con IA)
    const beforeDataUrl = `data:image/png;base64,${beforePng.toString("base64")}`;
    const upscaledUrl = await replicatePredict(
      UPSCALE_MODEL,
      { image: beforeDataUrl, scale: 4, face_enhance: false },
      replicateToken
    );
    let resultBuffer = await fetchBuffer(upscaledUrl);

    // 2) Quita el fondo, si se pidió
    if (job.remove_background) {
      const resultPngForBg = await sharp(resultBuffer).png().toBuffer();
      const resultDataUrl = `data:image/png;base64,${resultPngForBg.toString("base64")}`;
      const noBgUrl = await replicatePredict(BG_REMOVE_MODEL, { image: resultDataUrl }, replicateToken);
      resultBuffer = await fetchBuffer(noBgUrl);
    }

    const afterPng = await sharp(resultBuffer).png().toBuffer();
    const afterMeta = await sharp(afterPng).metadata();
    const afterPath = `${job.user_id}/enhance/${job.id}-after.png`;
    const { error: afterUpErr } = await supabase.storage
      .from("print-files")
      .upload(afterPath, afterPng, { contentType: "image/png", upsert: true });
    if (afterUpErr) throw new Error(`No se pudo guardar el resultado: ${afterUpErr.message}`);

    // 3) Arma un PDF de una página con el resultado final, a 300dpi
    const pdfDoc = await PDFDocument.create();
    const embeddedPng = await pdfDoc.embedPng(afterPng);
    const pageWidthPt = (afterMeta.width / PRINT_DPI) * 72;
    const pageHeightPt = (afterMeta.height / PRINT_DPI) * 72;
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    page.drawImage(embeddedPng, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });
    const enhancedPdfBytes = await pdfDoc.save();
    const enhancedPdfPath = `${job.user_id}/enhance/${job.id}-mejorado.pdf`;
    const { error: pdfUpErr } = await supabase.storage
      .from("print-files")
      .upload(enhancedPdfPath, enhancedPdfBytes, { contentType: "application/pdf", upsert: true });
    if (pdfUpErr) throw new Error(`No se pudo guardar el PDF mejorado: ${pdfUpErr.message}`);

    const upscaleFactor = beforeMeta.width ? Math.round((afterMeta.width / beforeMeta.width) * 10) / 10 : null;

    const enhance_report = {
      before_path: beforePath,
      after_path: afterPath,
      enhanced_pdf_path: enhancedPdfPath,
      imprimible_300dpi_cm: {
        ancho: Math.round((afterMeta.width / PRINT_DPI) * 2.54 * 10) / 10,
        alto: Math.round((afterMeta.height / PRINT_DPI) * 2.54 * 10) / 10,
      },
      upscale_factor: upscaleFactor ? `${upscaleFactor}x` : null,
      fondo_removido: !!job.remove_background,
    };

    await supabase.from("print_jobs").update({ enhanced_status: "done", enhance_report }).eq("id", job.id);
  } catch (err) {
    await supabase
      .from("print_jobs")
      .update({ enhanced_status: "failed", enhance_report: { error: err?.message || String(err) } })
      .eq("id", jobId);
  }

  return new Response("ok", { status: 200 });
};
