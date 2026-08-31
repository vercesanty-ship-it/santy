import { createClient } from "@supabase/supabase-js";

export const config = { path: "/api/create-subscription" };

const PRICE_USD = 5;

async function getDolarOficialVenta() {
  const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
  if (!res.ok) throw new Error("No pudimos consultar la cotización del dólar oficial.");
  const data = await res.json();
  if (!data.venta) throw new Error("La cotización del dólar oficial no está disponible.");
  return data.venta;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const supabase = createClient(Netlify.env.get("SUPABASE_URL"), Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const mpToken = Netlify.env.get("MERCADOPAGO_ACCESS_TOKEN");

  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return new Response(JSON.stringify({ error: "No autenticado." }), { status: 401 });

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Sesión inválida." }), { status: 401 });
    }
    const user = userData.user;

    const dolarVenta = await getDolarOficialVenta();
    const amountArs = Math.round(PRICE_USD * dolarVenta);

    const siteUrl = Netlify.env.get("URL") || `https://${req.headers.get("host")}`;
    // "reelizate" en la referencia distingue esta suscripción de las de
    // otros productos que puedan compartir la misma cuenta de Mercado Pago.
    const externalReference = `reelizate:${user.id}`;

    const mpRes = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: { Authorization: `Bearer ${mpToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Reelizate — Plan mensual",
        external_reference: externalReference,
        payer_email: user.email,
        back_url: `${siteUrl}/dashboard.html`,
        // Clave: apunta el webhook explícitamente a ESTE sitio, para que no
        // dependa del webhook por defecto configurado a nivel de cuenta de
        // Mercado Pago (que puede estar apuntando a otro producto).
        notification_url: `${siteUrl}/api/mercadopago-webhook`,
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
    return new Response(JSON.stringify({ error: err?.message || String(err) }), { status: 500 });
  }
};
