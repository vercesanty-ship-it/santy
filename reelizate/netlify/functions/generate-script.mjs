import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const config = { path: "/api/generate-script" };

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "No autenticado." }), { status: 401 });
    }

    if (userData.user.email !== "vercesanty@gmail.com") {
      const { data: profile } = await supabase.from("profiles").select("subscription_status").eq("id", userData.user.id).single();
      if (profile?.subscription_status !== "active") {
        return new Response(JSON.stringify({ error: "Necesitás una suscripción activa para generar guiones." }), { status: 402 });
      }
    }

    const { topic } = await req.json();
    if (!topic || !topic.trim()) {
      return new Response(JSON.stringify({ error: "Contanos sobre qué querés el guion." }), { status: 400 });
    }

    const anthropic = new Anthropic({ apiKey: Netlify.env.get("ANTHROPIC_API_KEY") });
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 700,
      messages: [{
        role: "user",
        content: `Sos un guionista experto en videos cortos para Instagram Reels / TikTok. Tema o nicho: "${topic}".\n\nDame, en español y directo (sin explicaciones extra):\n1. Tres ganchos distintos para los primeros 3 segundos.\n2. Una estructura de guion sugerida (intro, desarrollo, cierre/CTA) para uno de esos ganchos.\n\nFormato en texto plano, prolijo, listo para grabar.`,
      }],
    });
    const script = msg.content?.[0]?.text || "";

    await supabase.from("scripts").insert({ user_id: userData.user.id, topic, content: script });

    return new Response(JSON.stringify({ script }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), { status: 500 });
  }
};
