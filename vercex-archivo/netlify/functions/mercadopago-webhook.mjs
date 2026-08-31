import { createClient } from "@supabase/supabase-js";

export const config = { path: "/api/mercadopago-webhook" };

// No hay MERCADOPAGO_WEBHOOK_SECRET configurado en el sitio, así que en vez
// de confiar en la firma del webhook (que además no tenemos forma de
// validar), seguimos la práctica recomendada por Mercado Pago: usar la
// notificación solo para saber "andá a buscar este recurso" y volver a
// pedirlo con nuestro access token, que es la fuente de verdad.
async function fetchMpResource(kind, id, token) {
  const path = kind === "payment" ? `/v1/payments/${id}` : `/preapproval/${id}`;
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`No se pudo consultar ${kind} ${id} en Mercado Pago (${res.status}).`);
  return res.json();
}

function parsePlan(externalReference) {
  const [userId, accountType, plan] = String(externalReference || "").split(":");
  if (!userId || !accountType || !plan) return null;
  return { userId, accountType, plan };
}

export default async (req) => {
  const supabase = createClient(
    Netlify.env.get("SUPABASE_URL"),
    Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY")
  );
  const mpToken = Netlify.env.get("MERCADOPAGO_ACCESS_TOKEN");

  try {
    const url = new URL(req.url);
    let type = url.searchParams.get("type") || url.searchParams.get("topic");
    let id = url.searchParams.get("data.id") || url.searchParams.get("id");

    if (!type || !id) {
      try {
        const body = await req.json();
        type = type || body.type || body.topic;
        id = id || body.data?.id || body.id;
      } catch {
        // sin body JSON: nos quedamos con lo que haya en la query
      }
    }

    if (!type || !id) return new Response("ok", { status: 200 }); // notificación que no reconocemos, no reintentar

    if (type === "preapproval" || type === "subscription_preapproval") {
      const preapproval = await fetchMpResource("preapproval", id, mpToken);
      const parsed = parsePlan(preapproval.external_reference);
      if (parsed) {
        const statusMap = { authorized: "active", paused: "past_due", cancelled: "canceled" };
        const subscription_status = statusMap[preapproval.status];
        if (subscription_status) {
          await supabase
            .from("profiles")
            .update({ plan: parsed.plan, subscription_status })
            .eq("id", parsed.userId);
        }
      }
    } else if (type === "payment" || type === "subscription_authorized_payment") {
      const payment = await fetchMpResource("payment", id, mpToken);
      const parsed = parsePlan(payment.external_reference);
      if (parsed) {
        const statusMap = { approved: "active", rejected: "past_due", cancelled: "past_due" };
        const subscription_status = statusMap[payment.status];
        if (subscription_status) {
          await supabase.from("profiles").update({ subscription_status }).eq("id", parsed.userId);
        }
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    // Devolvemos 200 igual: si el error es nuestro, que Mercado Pago no
    // reintente indefinidamente. Queda registrado en los logs de la función.
    console.error("mercadopago-webhook error:", err?.message || err);
    return new Response("ok", { status: 200 });
  }
};
