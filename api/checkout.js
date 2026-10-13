// POST /api/checkout : crée la page de paiement Stripe pour l'offre choisie.
// Corps attendu : { "plan": "monthly" | "quarterly" | "lifetime", "waiver": true }
const Stripe = require("stripe");
const { getUser, getProfile, saveProfile, siteUrl } = require("./_supabase");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

// Identifiants des prix Stripe, à renseigner dans les variables d'environnement Vercel
const PLANS = {
  monthly:   { env: "STRIPE_PRICE_MONTHLY",   price: process.env.STRIPE_PRICE_MONTHLY || process.env.STRIPE_PRICE_ID, mode: "subscription", label: "mensuelle (9,99 € par mois, récurrent)" },
  quarterly: { env: "STRIPE_PRICE_QUARTERLY", price: process.env.STRIPE_PRICE_QUARTERLY, mode: "subscription", label: "3 mois (19,99 € tous les 3 mois, récurrent)" },
  lifetime:  { env: "STRIPE_PRICE_LIFETIME",  price: process.env.STRIPE_PRICE_LIFETIME,  mode: "payment",      label: "à vie (39,99 €, paiement unique)" },
};

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

// Variables Vercel indispensables (leurs noms seulement, jamais leurs valeurs)
function missingConfig() {
  return ["STRIPE_SECRET_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
}

// Traduit les erreurs de configuration en message clair (aucune donnée secrète n'y figure)
function explain(err, plan) {
  const msg = String((err && err.message) || "");
  if (err && err.type === "StripeAuthenticationError") return "Clé secrète Stripe refusée : vérifiez STRIPE_SECRET_KEY dans Vercel.";
  if (/No such price/i.test(msg)) {
    const otherMode = /(test|live) mode/i.test(msg) ? " Le prix et la clé secrète ne sont pas dans le même mode (test ou réel)." : "";
    return `Prix Stripe introuvable pour l'offre ${plan.label} : vérifiez ${plan.env} dans Vercel (identifiant commençant par price_, pas prod_).${otherMode}`;
  }
  if (/recurring price|recurring/i.test(msg)) {
    return `Le prix de l'offre ${plan.label} n'a pas le bon type dans Stripe : il doit être ${plan.mode === "payment" ? "« Ponctuel » (paiement unique)" : "« Récurrent »"}. Vérifiez ${plan.env}.`;
  }
  if (/Lecture du profil|Enregistrement du profil/.test(msg)) return `Supabase refuse l'accès aux profils : vérifiez SUPABASE_SERVICE_ROLE_KEY dans Vercel et que supabase-premium.sql a bien été exécuté. (${msg.slice(0, 160)})`;
  if (err && err.type && err.type.startsWith("Stripe")) return `Stripe : ${msg}`;
  return `Le paiement n'a pas pu démarrer : ${msg || "erreur inconnue"}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  const missing = missingConfig();
  if (missing.length) return res.status(500).json({ error: `Configuration incomplète dans Vercel : ajoutez ${missing.join(", ")}, puis redéployez.` });

  let plan = PLANS.monthly;
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = token && (await getUser(token));
    if (!user || !user.id) return res.status(401).json({ error: "Connectez-vous pour passer Premium." });

    const body = await readBody(req);
    const planKey = PLANS[body.plan] ? body.plan : "monthly";
    plan = PLANS[planKey];
    if (!plan.price) return res.status(500).json({ error: `Cette offre n'est pas encore disponible : ajoutez ${plan.env} dans Vercel, puis redéployez.` });
    if (!body.waiver) return res.status(400).json({ error: "Cochez la case de demande d'accès immédiat pour continuer." });

    const profile = await getProfile(user.id);
    if (profile && profile.is_premium) return res.status(400).json({ error: "Vous êtes déjà Premium." });

    const newCustomer = async () => {
      const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
      await saveProfile(user.id, { stripe_customer_id: c.id });
      return c.id;
    };
    // Un seul client Stripe par compte Valisino
    let customer = (profile && profile.stripe_customer_id) || (await newCustomer());

    const site = siteUrl(req);
    const params = () => {
      const p = {
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
      if (plan.mode === "subscription") p.subscription_data = { metadata: { user_id: user.id, plan: planKey } };
      else p.invoice_creation = { enabled: true }; // facture pour le paiement unique
      return p;
    };

    let session;
    try {
      session = await stripe.checkout.sessions.create(params());
    } catch (err) {
      // Client enregistré dans un autre mode Stripe (test ou réel) ou supprimé : on en recrée un
      if (err.code === "resource_missing" && err.param === "customer") {
        customer = await newCustomer();
        session = await stripe.checkout.sessions.create(params());
      } else throw err;
    }
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: explain(err, plan) });
  }
};
