// Datos públicos del proyecto Supabase (seguros para exponer en el navegador,
// el acceso real lo controla Row Level Security en la base de datos).
const SUPABASE_URL = "https://yetgkjusooedkwrbywgw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HgRLRwZHD9urSnbOz0rsIA_I2LPgGWy";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
