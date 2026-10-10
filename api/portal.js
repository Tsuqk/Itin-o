// POST /api/portal : ouvre l'espace Stripe où l'abonné gère ou résilie son abonnement.
const Stripe = require("stripe");
const { getUser, getProfile, siteUrl } = require("./_supabase");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = token && (await getUser(token));
    if (!user || !user.id) return res.status(401).json({ error: "Connectez-vous d'abord." });

    const profile = await getProfile(user.id);
    if (!profile || !profile.stripe_customer_id) return res.status(400).json({ error: "Aucun abonnement trouvé pour ce compte." });

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${siteUrl(req)}/`,
      locale: "fr",
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "L'espace abonnement n'a pas pu s'ouvrir. Réessayez dans un instant." });
  }
};
