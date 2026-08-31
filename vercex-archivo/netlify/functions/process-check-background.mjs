import { createClient } from "@supabase/supabase-js";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";

export const config = { path: "/api/process-check" };

const MM_PER_PT = 25.4 / 72;
const BLEED_MM = 3; // sangrado estándar de imprenta
const LOW_RES_THRESHOLD_PPI = 150;

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

    if (!job.original_path) throw new Error("El trabajo no tiene un archivo original.");

    const { data: fileBlob, error: dlErr } = await supabase.storage
      .from("print-files")
      .download(job.original_path);
    if (dlErr) throw new Error(`No se pudo descargar el PDF: ${dlErr.message}`);

    const inputBytes = new Uint8Array(await fileBlob.arrayBuffer());
    const pdfDoc = await PDFDocument.load(inputBytes, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    if (pages.length === 0) throw new Error("El PDF no tiene páginas.");

    const { width: widthPt, height: heightPt } = pages[0].getSize();
    const anchoOriginalMm = Math.round(widthPt * MM_PER_PT * 10) / 10;
    const altoOriginalMm = Math.round(heightPt * MM_PER_PT * 10) / 10;

    // Estima la resolución efectiva mirando las imágenes embebidas: pdf-lib
    // no expone el tamaño de despliegue real (eso está en la matriz "cm"
    // del content stream, no en el diccionario del XObject), así que
    // asumimos que la imagen ocupa el área de la página — válido para el
    // caso típico de un archivo de diseño recortado al tamaño final, y
    // conservador (subestima antes que sobreestimar la calidad) si no lo es.
    let minEffectivePpi = null;
    for (const page of pages) {
      const resources = page.node.Resources();
      const xObjects = resources?.lookup(PDFName.of("XObject"), PDFDict);
      if (!xObjects) continue;
      const { width: pw, height: ph } = page.getSize();
      for (const key of xObjects.keys()) {
        const xObject = xObjects.lookup(key);
        const subtype = xObject?.dict?.get?.(PDFName.of("Subtype"));
        if (!subtype || subtype.toString() !== "/Image") continue;
        const w = xObject.dict.get(PDFName.of("Width"))?.asNumber?.();
        const h = xObject.dict.get(PDFName.of("Height"))?.asNumber?.();
        if (!w || !h) continue;
        const effectivePpi = Math.round(Math.min(w / (pw / 72), h / (ph / 72)));
        if (minEffectivePpi === null || effectivePpi < minEffectivePpi) minEffectivePpi = effectivePpi;
      }
    }

    // Aplana campos de formulario si el PDF los trae (algunos exportadores
    // dejan capas editables); no todos los PDFs los tienen.
    let flattened = false;
    try {
      const form = pdfDoc.getForm();
      if (form.getFields().length > 0) {
        form.flatten();
        flattened = true;
      }
    } catch {
      // el PDF no tiene AcroForm: no hay nada que aplanar
    }

    // Agrega sangrado extendiendo el MediaBox de cada página. No inventa
    // contenido nuevo: el margen extra queda transparente para que se
    // revise antes de imprimir.
    const bleedPt = (BLEED_MM / 10) * (72 / 2.54);
    for (const page of pages) {
      const { width, height } = page.getSize();
      page.setMediaBox(-bleedPt, -bleedPt, width + bleedPt * 2, height + bleedPt * 2);
    }

    const outputBytes = await pdfDoc.save();
    const resultPath = job.original_path.replace(/\.pdf$/i, "") + "-corregido.pdf";
    const { error: upErr } = await supabase.storage
      .from("print-files")
      .upload(resultPath, outputBytes, { contentType: "application/pdf", upsert: true });
    if (upErr) throw new Error(`No se pudo guardar el archivo corregido: ${upErr.message}`);

    const report = {
      resolucion_ppi: minEffectivePpi,
      tamano_original_mm: { ancho: anchoOriginalMm, alto: altoOriginalMm },
      sangrado_agregado_mm: BLEED_MM,
      tamano_final_mm: {
        ancho: Math.round((anchoOriginalMm + BLEED_MM * 2) * 10) / 10,
        alto: Math.round((altoOriginalMm + BLEED_MM * 2) * 10) / 10,
      },
      efectos_aplanados: flattened,
      color_nota:
        minEffectivePpi !== null && minEffectivePpi < LOW_RES_THRESHOLD_PPI
          ? `La imagen tiene ~${minEffectivePpi} ppi: puede verse borrosa al imprimir. Probá "Corrección de IA" para mejorarla.`
          : null,
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
