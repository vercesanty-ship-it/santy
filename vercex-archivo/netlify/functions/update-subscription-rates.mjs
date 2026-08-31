// dashboard.html le avisa al usuario: "El monto en pesos se calcula con el
// dólar oficial del día en que te suscribís, y se actualiza automáticamente
// antes de cada cobro mensual." Este cron es el que cumple esa promesa:
// actualiza el transaction_amount de cada preapproval activa en Mercado
// Pago para que el próximo cobro use la cotización de hoy.
export const config = { schedule: "@daily" };

const PLAN_DEFS = {
  empresa: { basico: 20, pro: 30, negocio: 40 },
  cliente: { basico: 3, pro: 7 },
};

async function getDolarOficialVenta() {
  const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
  if (!res.ok) throw new Error("No pudimos consultar la cotización del dólar oficial.");
  const data = await res.json();
  if (!data.venta) throw new Error("La cotización del dólar oficial no está disponible.");
  return data.venta;
}

async function fetchAuthorizedPreapprovals(token) {
  const results = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const res = await fetch(
      `https://api.mercadopago.com/preapproval/search?status=authorized&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Mercado Pago (preapproval/search) devolvió ${res.status}.`);
    const data = await res.json();
    const page = data.results || [];
    results.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return results;
}

export default async () => {
  const mpToken = Netlify.env.get("MERCADOPAGO_ACCESS_TOKEN");
  const dolarVenta = await getDolarOficialVenta();

  const preapprovals = await fetchAuthorizedPreapprovals(mpToken);
  let updated = 0;
  let skipped = 0;

  for (const preapproval of preapprovals) {
    const [userId, accountType, plan] = String(preapproval.external_reference || "").split(":");
    const priceUsd = PLAN_DEFS[accountType]?.[plan];
    if (!userId || !priceUsd) {
      skipped++;
      continue;
    }

    const newAmountArs = Math.round(priceUsd * dolarVenta);
    if (newAmountArs === preapproval.auto_recurring?.transaction_amount) {
      skipped++;
      continue;
    }

    const putRes = await fetch(`https://api.mercadopago.com/preapproval/${preapproval.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${mpToken}`, "content-type": "application/json" },
      body: JSON.stringify({ auto_recurring: { transaction_amount: newAmountArs } }),
    });
    if (!putRes.ok) {
      console.error(`update-subscription-rates: no se pudo actualizar ${preapproval.id} (${putRes.status}).`);
      continue;
    }
    updated++;
  }

  console.log(
    `update-subscription-rates: dólar oficial venta=${dolarVenta}, ${updated} preapprovals actualizadas, ${skipped} sin cambios.`
  );
};
