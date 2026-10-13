// Outils partagés par les fonctions Stripe (le "_" évite que Vercel en fasse une route).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Les nouvelles clés "sb_secret_..." passent uniquement dans l'en-tête apikey ;
// les anciennes clés service_role (JWT) passent aussi en Authorization.
function adminHeaders(extra = {}) {
  const h = { apikey: SECRET, "Content-Type": "application/json", ...extra };
  if (!SECRET.startsWith("sb_")) h.Authorization = `Bearer ${SECRET}`;
  return h;
}

// Vérifie le jeton de connexion envoyé par le site et renvoie l'utilisateur.
async function getUser(accessToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SECRET, Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  return r.json();
}

async function getProfile(userId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}&select=*`, {
    headers: adminHeaders(),
  });
  if (!r.ok) throw new Error(`Lecture du profil impossible (${r.status})`);
  const rows = await r.json();
  return rows[0] || null;
}

async function getProfileByCustomer(customerId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${customerId}&select=user_id`, {
    headers: adminHeaders(),
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function saveProfile(userId, fields) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?on_conflict=user_id`, {
    method: "POST",
    headers: adminHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ user_id: userId, ...fields, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Enregistrement du profil impossible (${r.status}) : ${await r.text()}`);
}

// Retour sur l'adresse même où le visiteur est connecté (la session est propre à chaque adresse)
function siteUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `https://${host}`;
  return (process.env.SITE_URL || "").replace(/\/$/, "");
}

module.exports = { getUser, getProfile, getProfileByCustomer, saveProfile, siteUrl };
