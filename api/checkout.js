// POST /api/checkout : crée la page de paiement Stripe pour l'offre choisie.
// Corps attendu : { "plan": "monthly" | "quarterly" | "lifetime" }
const Stripe = require("stripe");
const { getUser, getProfile, saveProfile, siteUrl } = require("./_supabase");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Identifiants des prix Stripe, à renseigner dans les variables d'environnement Vercel
const PLANS = {
  monthly:   { price: process.env.STRIPE_PRICE_MONTHLY || process.env.STRIPE_PRICE_ID, mode: "subscription" }, // 9,99 € / mois
  quarterly: { price: process.env.STRIPE_PRICE_QUARTERLY, mode: "subscription" },                            // 19,99 € / 3 mois
  lifetime:  { price: process.env.STRIPE_PRICE_LIFETIME, mode: "payment" },                                  // 39,99 € une fois
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = token && (await getUser(token));
    if (!user || !user.id) return res.status(401).json({ error: "Connectez-vous pour passer Premium." });

    const body = await readBody(req);
    const planKey = PLANS[body.plan] ? body.plan : "monthly";
    const plan = PLANS[planKey];
    if (!plan.price) return res.status(500).json({ error: "Cette offre n'est pas encore disponible." });
    if (!body.waiver) return res.status(400).json({ error: "Cochez la case de demande d'accès immédiat pour continuer." });

    const profile = await getProfile(user.id);
    if (profile && profile.is_premium) return res.status(400).json({ error: "Vous êtes déjà Premium." });

    // Un seul client Stripe par compte Itinéo
    let customer = profile && profile.stripe_customer_id;
    if (!customer) {
      const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
      customer = c.id;
      await saveProfile(user.id, { stripe_customer_id: customer });
    }

    const site = siteUrl(req);
    const params = {
      mode: plan.mode,
      customer,
      client_reference_id: user.id,
      line_items: [{ price: plan.price, quantity: 1 }],
      metadata: { user_id: user.id, plan: planKey, waiver_accepted_at: new Date().toISOString() },
      allow_promotion_codes: true,
      locale: "fr",
      success_url: `${site}/?premium=ok`,
      cancel_url: `${site}/?premium=annule`,
    };
    if (plan.mode === "subscription") params.subscription_data = { metadata: { user_id: user.id, plan: planKey } };
    else params.invoice_creation = { enabled: true }; // facture pour le paiement unique

    const session = await stripe.checkout.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Le paiement n'a pas pu démarrer. Réessayez dans un instant." });
  }
};
