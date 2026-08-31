import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

export const config = { path: "/api/build-plancha" };

// Resolución de impresión: 150 DPI es un estándar razonable para DTF/sublimado
// a este tamaño de plancha, y mantiene el PNG final en un tamaño manejable.
const DPI = 150;
const PX_PER_CM = DPI / 2.54;
const GAP_MM = 5;
const GAP_PX = Math.round((GAP_MM / 10) * PX_PER_CM);
const SHEET_WIDTH_CM = 58;
const SHEET_WIDTH_PX = Math.round(SHEET_WIDTH_CM * PX_PER_CM);
// Tope de seguridad para no generar planchas absurdamente largas por un typo.
const MAX_SHEET_HEIGHT_CM = 2000;

function cmToPx(cm) {
  return Math.max(1, Math.round(cm * PX_PER_CM));
}

// Ubica una fila de diseños uno al lado del otro, de izquierda a derecha,
// respetando el ancho fijo de la plancha. Devuelve el alto que ocupó la fila.
function packRow(items, composites, currentY, maxHeightPx) {
  let currentX = 0;
  let rowHeight = 0;
  for (const d of items) {
    if (currentX + d.widthPx > SHEET_WIDTH_PX) continue;
    if (currentY + d.heightPx > maxHeightPx) continue;
    composites.push({ input: d.buffer, left: currentX, top: currentY });
    d.placedCount += 1;
    currentX += d.widthPx + GAP_PX;
    rowHeight = Math.max(rowHeight, d.heightPx);
  }
  return rowHeight;
}

export default async (req) => {
  const supabase = createClient(
    Netlify.env.get("SUPABASE_URL"),
    Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );

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

    const inputPaths = job.input_paths || [];
    const designSizes = job.design_sizes || [];
    if (inputPaths.length === 0) throw new Error("El trabajo no tiene imágenes.");
    if (designSizes.length !== inputPaths.length) {
      throw new Error("La cantidad de tamaños no coincide con la cantidad de imágenes subidas.");
    }

    // Descarga y redimensiona TODOS los diseños subidos (no solo el primero).
    const designs = [];
    for (let i = 0; i < inputPaths.length; i++) {
      const { data: fileBlob, error: dlErr } = await supabase.storage
        .from("print-files")
        .download(inputPaths[i]);
      if (dlErr) throw new Error(`No se pudo descargar el diseño ${i + 1}: ${dlErr.message}`);

      const buffer = Buffer.from(await fileBlob.arrayBuffer());
      const size = designSizes[i] || {};
      const widthPx = cmToPx(size.width_cm);
      const heightPx = cmToPx(size.height_cm);
      const resized = await sharp(buffer).resize(widthPx, heightPx, { fit: "fill" }).png().toBuffer();

      designs.push({
        buffer: resized,
        widthPx,
        heightPx,
        widthCm: size.width_cm,
        heightCm: size.height_cm,
        qtyExact: size.quantity && size.quantity > 0 ? size.quantity : null,
        placedCount: 0,
      });
    }

    const maxHeightPx = cmToPx(Math.min(job.requested_meters * 100, MAX_SHEET_HEIGHT_CM));
    const composites = [];
    let currentY = 0;

    // 1) Diseños con cantidad exacta pedida: se colocan primero, en el orden pedido.
    const exactQueue = [];
    for (const d of designs) {
      if (d.qtyExact) for (let n = 0; n < d.qtyExact; n++) exactQueue.push(d);
    }
    while (exactQueue.length > 0 && currentY < maxHeightPx) {
      const rowItems = [];
      let widthUsed = 0;
      for (let i = 0; i < exactQueue.length; ) {
        const d = exactQueue[i];
        if (widthUsed + d.widthPx <= SHEET_WIDTH_PX) {
          rowItems.push(d);
          widthUsed += d.widthPx + GAP_PX;
          exactQueue.splice(i, 1);
        } else {
          i++;
        }
      }
      if (rowItems.length === 0) break; // ni uno solo entra en el ancho de la plancha
      const rowHeight = packRow(rowItems, composites, currentY, maxHeightPx);
      if (rowHeight === 0) break; // no había alto disponible para esta fila
      currentY += rowHeight + GAP_PX;
    }

    // 2) Diseños "automáticos" (sin cantidad pedida): rellenan el material
    // restante repartiendo turnos entre todos por igual (round-robin).
    const autoDesigns = designs.filter((d) => !d.qtyExact);
    if (autoDesigns.length > 0) {
      let keepGoing = true;
      while (keepGoing && currentY < maxHeightPx) {
        const rowItems = [];
        let widthUsed = 0;
        for (const d of autoDesigns) {
          if (widthUsed + d.widthPx <= SHEET_WIDTH_PX) {
            rowItems.push(d);
            widthUsed += d.widthPx + GAP_PX;
          }
        }
        if (rowItems.length === 0) { keepGoing = false; break; }
        const rowHeight = packRow(rowItems, composites, currentY, maxHeightPx);
        if (rowHeight === 0) { keepGoing = false; break; }
        currentY += rowHeight + GAP_PX;
      }
    }

    if (composites.length === 0) {
      throw new Error("Ningún diseño entra en el ancho de 58cm con los tamaños indicados.");
    }

    const finalHeightPx = Math.min(currentY, maxHeightPx);

    const sheetBuffer = await sharp({
      create: {
        width: SHEET_WIDTH_PX,
        height: Math.max(finalHeightPx, 1),
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(composites)
      .png()
      .toBuffer();

    const resultPath = `${job.user_id}/results/${job.id}-plancha.png`;
    const { error: upErr } = await supabase.storage
      .from("print-files")
      .upload(resultPath, sheetBuffer, { contentType: "image/png", upsert: true });
    if (upErr) throw new Error(`No se pudo guardar la plancha armada: ${upErr.message}`);

    const report = {
      disenos_subidos: designs.length,
      total_colocados: designs.reduce((sum, d) => sum + d.placedCount, 0),
      tamanos_disenios_cm: designs.map((d) => `${d.widthCm}x${d.heightCm}`),
      repeticiones_por_diseno: designs.map((d) => d.placedCount),
      ancho_cm: SHEET_WIDTH_CM,
      alto_cm: Math.round((finalHeightPx / PX_PER_CM) * 10) / 10,
      metros_solicitados: job.requested_meters,
      fondo_removido: !!job.remove_background,
      separacion_mm: GAP_MM,
    };

    await supabase
      .from("print_jobs")
      .update({ status: "done", result_path: resultPath, report })
      .eq("id", job.id);
  } catch (err) {
    await supabase
      .from("print_jobs")
      .update({ status: "failed", report: { error: err?.message || String(err) } })
      .eq("id", jobId);
  }

  return new Response("ok", { status: 200 });
};
