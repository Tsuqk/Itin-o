// POST /api/checkout : crée une page de paiement Stripe pour l'abonnement Premium.
const Stripe = require("stripe");
const { getUser, getProfile, saveProfile, siteUrl } = require("./_supabase");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = token && (await getUser(token));
    if (!user || !user.id) return res.status(401).json({ error: "Connectez-vous pour passer Premium." });

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
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: true,
      locale: "fr",
      success_url: `${site}/?premium=ok`,
      cancel_url: `${site}/?premium=annule`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Le paiement n'a pas pu démarrer. Réessayez dans un instant." });
  }
};
