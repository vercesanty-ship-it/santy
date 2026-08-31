import { createClient } from "@supabase/supabase-js";

// dashboard.html avisa "Vencido (archivo borrado a los 20 días)" para todo
// job con status "done" y result_path vacío — este cron es el que produce
// ese estado, liberando espacio de Storage sin borrar el historial del job.
export const config = { schedule: "@daily" };

const RETENTION_DAYS = 20;

function collectPaths(job) {
  const paths = [job.original_path, job.result_path].filter(Boolean);
  if (Array.isArray(job.input_paths)) paths.push(...job.input_paths);
  const er = job.enhance_report;
  if (er) [er.before_path, er.after_path, er.enhanced_pdf_path].forEach((p) => p && paths.push(p));
  return paths;
}

export default async () => {
  const supabase = createClient(
    Netlify.env.get("SUPABASE_URL"),
    Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: jobs, error } = await supabase
    .from("print_jobs")
    .select("*")
    .lt("created_at", cutoff)
    .not("status", "eq", "processing");

  if (error) {
    console.error("cleanup-old-files: no se pudo leer print_jobs:", error.message);
    return;
  }

  const expired = (jobs || []).filter((j) => j.original_path || j.result_path || j.input_paths?.length);
  if (expired.length === 0) {
    console.log("cleanup-old-files: nada para limpiar.");
    return;
  }

  const allPaths = expired.flatMap(collectPaths);
  if (allPaths.length > 0) {
    const { error: removeErr } = await supabase.storage.from("print-files").remove(allPaths);
    if (removeErr) console.error("cleanup-old-files: error borrando de storage:", removeErr.message);
  }

  for (const job of expired) {
    await supabase
      .from("print_jobs")
      .update({
        original_path: null,
        result_path: null,
        input_paths: job.input_paths ? [] : job.input_paths,
        enhance_report: job.enhance_report ? { ...job.enhance_report, before_path: null, after_path: null, enhanced_pdf_path: null } : job.enhance_report,
      })
      .eq("id", job.id);
  }

  console.log(`cleanup-old-files: limpiados ${expired.length} trabajos, ${allPaths.length} archivos borrados.`);
};
