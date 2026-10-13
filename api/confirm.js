// POST /api/confirm : au retour de Stripe, vérifie le paiement et active Premium tout de suite,
// sans attendre le webhook (qui reste la référence pour les renouvellements et résiliations).
// Corps attendu : { "session_id": "cs_..." }
const Stripe = require("stripe");
const { getUser, getProfile, saveProfile } = require("./_supabase");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const ACTIVE = ["active", "trialing"];

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = token && (await getUser(token));
    if (!user || !user.id) return res.status(401).json({ error: "Connectez-vous d'abord." });

    const id = String(readBody(req).session_id || "");
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Paiement introuvable." });

    const s = await stripe.checkout.sessions.retrieve(id);
    // Le paiement doit appartenir au compte connecté
    if (s.client_reference_id !== user.id) return res.status(403).json({ error: "Ce paiement a été fait depuis un autre compte." });
    if (s.status !== "complete") return res.status(200).json({ is_premium: false, pending: true });

    const current = await getProfile(user.id);
    if (s.mode === "payment") {
      if (s.payment_status === "paid") {
        await saveProfile(user.id, { stripe_customer_id: s.customer, subscription_status: "lifetime", is_premium: true, current_period_end: null });
      }
    } else if (s.subscription && !(current && current.subscription_status === "lifetime")) {
      const sub = await stripe.subscriptions.retrieve(s.subscription);
      const ts = sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);
      await saveProfile(user.id, {
        stripe_customer_id: s.customer,
        subscription_status: sub.status,
        is_premium: ACTIVE.includes(sub.status),
        current_period_end: ts ? new Date(ts * 1000).toISOString() : null,
      });
    }
    const p = await getProfile(user.id);
    return res.status(200).json({ is_premium: !!(p && p.is_premium) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Vérification du paiement impossible pour le moment." });
  }
};
