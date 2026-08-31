// Datos públicos del proyecto Supabase (seguros para exponer en el navegador,
// el acceso real lo controla Row Level Security en la base de datos).
//
// TODO: reemplazar con las credenciales del proyecto de Supabase de Reelizate
// (nuevo y separado del de Vercex Archivo) una vez creado en supabase.com.
const SUPABASE_URL = "REEMPLAZAR_CON_SUPABASE_URL";
const SUPABASE_PUBLISHABLE_KEY = "REEMPLAZAR_CON_SUPABASE_ANON_KEY";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
