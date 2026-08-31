import { createClient } from "@supabase/supabase-js";

export const config = { schedule: "@daily" };

const RETENTION_DAYS = 20;

async function cleanupTable(supabase, table, hasUserId) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: jobs, error } = await supabase.from(table).select("*").lt("created_at", cutoff).not("status", "eq", "processing");
  if (error) {
    console.error(`cleanup-old-files: no se pudo leer ${table}:`, error.message);
    return;
  }
  const expired = (jobs || []).filter((j) => j.input_path || j.result_path);
  if (expired.length === 0) return;

  const paths = expired.flatMap((j) => [j.input_path, j.result_path].filter(Boolean));
  if (paths.length > 0) {
    const { error: rmErr } = await supabase.storage.from("reel-files").remove(paths);
    if (rmErr) console.error(`cleanup-old-files: error borrando archivos de ${table}:`, rmErr.message);
  }
  for (const job of expired) {
    await supabase.from(table).update({ input_path: null, result_path: null }).eq("id", job.id);
  }
  console.log(`cleanup-old-files: ${table} — limpiados ${expired.length} trabajos.`);
}

export default async () => {
  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  await cleanupTable(supabase, "video_jobs");
  await cleanupTable(supabase, "trial_jobs");
};
