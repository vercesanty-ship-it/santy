import { createClient } from "@supabase/supabase-js";

export const config = { path: "/api/mercadopago-webhook" };

async function fetchMpResource(kind, id, token) {
  const path = kind === "payment" ? `/v1/payments/${id}` : `/preapproval/${id}`;
  const res = await fetch(`https://api.mercadopago.com${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`No se pudo consultar ${kind} ${id} en Mercado Pago (${res.status}).`);
  return res.json();
}

function parseReference(externalReference) {
  const [product, userId, plan] = String(externalReference || "").split(":");
  if (product !== "reelizate" || !userId) return null;
  return { userId, plan: plan || null };
}

export default async (req) => {
  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY"));
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
    if (!type || !id) return new Response("ok", { status: 200 });

    if (type === "preapproval" || type === "subscription_preapproval") {
      const preapproval = await fetchMpResource("preapproval", id, mpToken);
      const parsed = parseReference(preapproval.external_reference);
      if (parsed) {
        const statusMap = { authorized: "active", paused: "past_due", cancelled: "canceled" };
        const subscription_status = statusMap[preapproval.status];
        if (subscription_status) {
          const update = { subscription_status };
          if (parsed.plan) update.plan = parsed.plan;
          await supabase.from("profiles").update(update).eq("id", parsed.userId);
        }
      }
    } else if (type === "payment" || type === "subscription_authorized_payment") {
      const payment = await fetchMpResource("payment", id, mpToken);
      const parsed = parseReference(payment.external_reference);
      if (parsed) {
        const statusMap = { approved: "active", rejected: "past_due", cancelled: "past_due" };
        const subscription_status = statusMap[payment.status];
        if (subscription_status) {
          const update = { subscription_status };
          if (parsed.plan) update.plan = parsed.plan;
          await supabase.from("profiles").update(update).eq("id", parsed.userId);
        }
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("mercadopago-webhook error:", err?.message || err);
    return new Response("ok", { status: 200 });
  }
};
