// POST /api/stripe-webhook : Stripe prévient ici à chaque paiement, renouvellement ou résiliation.
// Le statut Premium du compte Supabase est mis à jour en conséquence.
const Stripe = require("stripe");
const { getProfileByCustomer, saveProfile } = require("./_supabase");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const ACTIVE = ["active", "trialing"];

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function periodEnd(sub) {
  const ts = sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function syncSubscription(sub, userIdHint) {
  let userId = userIdHint || (sub.metadata && sub.metadata.user_id);
  if (!userId) {
    const p = await getProfileByCustomer(sub.customer);
    userId = p && p.user_id;
  }
  if (!userId) throw new Error(`Utilisateur introuvable pour l'abonnement ${sub.id}`);
  await saveProfile(userId, {
    stripe_customer_id: sub.customer,
    subscription_status: sub.status,
    is_premium: ACTIVE.includes(sub.status),
    current_period_end: periodEnd(sub),
  });
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    event = stripe.webhooks.constructEvent(await rawBody(req), req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Signature invalide :", err.message);
    return res.status(400).send(`Signature invalide : ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.mode === "subscription" && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          await syncSubscription(sub, s.client_reference_id);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncSubscription(event.data.object);
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message }); // Stripe réessaiera automatiquement
  }
}

module.exports = handler;
// Stripe a besoin du corps brut de la requête pour vérifier la signature.
module.exports.config = { api: { bodyParser: false } };
