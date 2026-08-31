import { createClient } from "@supabase/supabase-js";

export const config = { path: "/api/create-subscription" };

// Mismos planes que en index.html / dashboard.html — se validan también acá
// porque el precio nunca debe depender de lo que mande el cliente.
const PLAN_DEFS = {
  empresa: {
    basico: { limit: 20, priceUsd: 20 },
    pro: { limit: 100, priceUsd: 30 },
    negocio: { limit: null, priceUsd: 40 },
  },
  cliente: {
    basico: { limit: 10, priceUsd: 3 },
    pro: { limit: 60, priceUsd: 7 },
  },
};
const PLAN_LABELS = { basico: "Básico", pro: "Pro", negocio: "Negocio" };

async function getDolarOficialVenta() {
  const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
  if (!res.ok) throw new Error("No pudimos consultar la cotización del dólar oficial.");
  const data = await res.json();
  if (!data.venta) throw new Error("La cotización del dólar oficial no está disponible.");
  return data.venta;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supabase = createClient(
    Netlify.env.get("SUPABASE_URL"),
    Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );
  const mpToken = Netlify.env.get("MERCADOPAGO_ACCESS_TOKEN");

  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return new Response(JSON.stringify({ error: "No autenticado." }), { status: 401 });

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Sesión inválida." }), { status: 401 });
    }
    const user = userData.user;

    const { plan } = await req.json();
    const { data: profile, error: profileErr } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();
    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: "No pudimos cargar tu cuenta." }), { status: 404 });
    }

    const defs = PLAN_DEFS[profile.account_type] || PLAN_DEFS.cliente;
    const planDef = defs[plan];
    if (!planDef) {
      return new Response(JSON.stringify({ error: "Plan inválido para tu tipo de cuenta." }), { status: 400 });
    }

    const dolarVenta = await getDolarOficialVenta();
    const amountArs = Math.round(planDef.priceUsd * dolarVenta);

    const siteUrl = Netlify.env.get("URL") || `https://${req.headers.get("host")}`;
    // external_reference guarda todo lo necesario (usuario, tipo de cuenta y
    // plan) para que el webhook y la sincronización de tarifas puedan operar
    // sin depender de otra tabla intermedia. El tipo de cuenta hace falta
    // porque "basico"/"pro" existen con precios distintos en cada uno.
    const externalReference = `${user.id}:${profile.account_type}:${plan}`;

    const mpRes = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: { Authorization: `Bearer ${mpToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        reason: `Vercex Archivo — Plan ${PLAN_LABELS[plan] || plan}`,
        external_reference: externalReference,
        payer_email: user.email,
        back_url: `${siteUrl}/dashboard.html`,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: amountArs,
          currency_id: "ARS",
        },
      }),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok || !mpData.init_point) {
      throw new Error(mpData?.message || "Mercado Pago no pudo generar el link de pago.");
    }

    return new Response(JSON.stringify({ init_point: mpData.init_point }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
