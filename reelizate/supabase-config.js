// Datos públicos del proyecto Supabase (seguros para exponer en el navegador,
// el acceso real lo controla Row Level Security en la base de datos).
//
const SUPABASE_URL = "https://hybotvfltawyckrhxdeo.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_yHAyYX_xgglDPOHtSr3DLw_0LjvMGLh";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
