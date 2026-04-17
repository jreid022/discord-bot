// VERSION SÉCURISÉE ADAPTÉE AUX RÉCOMPENSES DE POINTS DE CHAÎNE
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/login", limiter);
app.use("/auth/", limiter);
app.use("/claim", limiter);

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;

// À AJOUTER DANS RAILWAY
const CLAIM_SECRET = process.env.CLAIM_SECRET; // secret pour sécuriser la création des claims
const REWARD_ID = process.env.REWARD_ID; // optionnel : id précis de la récompense Twitch
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "849687556865130506";

const TWITCH_REDIRECT = "https://discord-bot-production-87ea.up.railway.app/auth/twitch/callback";
const DISCORD_REDIRECT = "https://discord-bot-production-87ea.up.railway.app/auth/discord/callback";
const BASE_URL = "https://discord-bot-production-87ea.up.railway.app";

const DISCORD_GUILD_ID = "668490005051736094";
const ROLE_NAME = "Marvien";

let linkedAccounts = new Map();
if (fs.existsSync("links.json")) {
  linkedAccounts = new Map(JSON.parse(fs.readFileSync("links.json", "utf8")));
}

// claims = autorisations temporaires créées après une vraie récompense Twitch
// clé = claimToken
// valeur = { twitchUserId, twitchLogin, redemptionId, rewardId, createdAt, expiresAt, used }
let claims = new Map();
if (fs.existsSync("claims.json")) {
  claims = new Map(JSON.parse(fs.readFileSync("claims.json", "utf8")));
}

const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

function saveClaims() {
  fs.writeFileSync("claims.json", JSON.stringify([...claims], null, 2));
}

function saveLinks() {
  fs.writeFileSync("links.json", JSON.stringify([...linkedAccounts], null, 2));
}

function appendLog(entry) {
  let logs = [];
  try {
    logs = JSON.parse(fs.readFileSync("logs.json", "utf8"));
    if (!Array.isArray(logs)) logs = [];
  } catch {
    logs = [];
  }

  logs.push({ ...entry, date: new Date().toISOString() });
  if (logs.length > 1000) logs = logs.slice(-1000);

  fs.writeFileSync("logs.json", JSON.stringify(logs, null, 2));
}

function cleanupExpiredClaims() {
  const now = Date.now();
  let changed = false;

  for (const [token, claim] of claims.entries()) {
    if (claim.expiresAt <= now || claim.used) {
      claims.delete(token);
      changed = true;
    }
  }

  if (changed) saveClaims();
}

setInterval(cleanupExpiredClaims, 60 * 1000);

// ==================================================
// 1) ROUTE INTERNE : créer un claim après récompense
// ==================================================
// Cette route doit être appelée UNIQUEMENT par ton système qui reçoit la récompense Twitch.
// Exemple body attendu :
// {
//   "secret": "ton_secret",
//   "twitchUserId": "123456",
//   "twitchLogin": "marvien",
//   "redemptionId": "abc123",
//   "rewardId": "reward_xyz"
// }

app.get("/claim/create", limiter, (req, res) => {
  try {
    const { secret, twitchUserId, twitchLogin, redemptionId, rewardId } = req.query;

    if (!CLAIM_SECRET) {
      return res.status(500).json({ error: "CLAIM_SECRET manquant" });
    }

    if (secret !== CLAIM_SECRET) {
      return res.status(403).json({ error: "Non autorisé" });
    }

    if (!twitchUserId || !twitchLogin || !redemptionId) {
      return res.status(400).json({ error: "Paramètres manquants" });
    }

    if (REWARD_ID && rewardId && rewardId !== REWARD_ID) {
      return res.status(400).json({ error: "Mauvaise récompense" });
    }

    // Empêche la réutilisation d'un même redeem
    for (const [, claim] of claims.entries()) {
      if (claim.redemptionId === String(redemptionId)) {
        return res.status(409).json({ error: "Redemption déjà enregistrée" });
      }
    }

    const claimToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();

    claims.set(claimToken, {
      twitchUserId: String(twitchUserId),
      twitchLogin: String(twitchLogin).toLowerCase(),
      redemptionId: String(redemptionId),
      rewardId: rewardId ? String(rewardId) : null,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000,
      used: false,
    });

    saveClaims();

    appendLog({
      type: "claim_created",
      twitchUserId: String(twitchUserId),
      twitchLogin: String(twitchLogin).toLowerCase(),
      redemptionId: String(redemptionId),
      rewardId: rewardId ? String(rewardId) : null,
    });

    return res.json({
      ok: true,
      loginUrl: `${BASE_URL}/login?claim=${claimToken}`,
      expiresInSeconds: 600,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Erreur création claim" });
  }
});
app.get("/claim/resolve", (req, res) => {
  try {
    cleanupExpiredClaims();

    const twitchLogin = String(req.query.twitchLogin || "").toLowerCase();
    if (!twitchLogin) {
      return res.status(400).send("❌ twitchLogin manquant");
    }

    let foundToken = null;
    let foundClaim = null;

    for (const [token, claim] of claims.entries()) {
      if (
        claim.twitchLogin === twitchLogin &&
        !claim.used &&
        claim.expiresAt > Date.now()
      ) {
        if (!foundClaim || claim.createdAt > foundClaim.createdAt) {
          foundToken = token;
          foundClaim = claim;
        }
      }
    }

    if (!foundToken) {
      return res.status(404).send("❌ Aucun accès valide trouvé");
    }

    return res.redirect(`${BASE_URL}/login?claim=${foundToken}`);
  } catch (error) {
    console.error(error);
    return res.status(500).send("❌ Erreur resolve");
  }
});
// =============================================
// 2) LOGIN TWITCH à partir d'un claim valide
// =============================================
app.get("/login", (req, res) => {
  cleanupExpiredClaims();

  const claimToken = req.query.claim;
  if (!claimToken) return res.status(400).send("❌ Claim manquant");

  const claim = claims.get(claimToken);
  if (!claim) return res.status(400).send("❌ Claim invalide");
  if (claim.used) return res.status(400).send("❌ Claim déjà utilisé");
  if (claim.expiresAt <= Date.now()) {
    claims.delete(claimToken);
    saveClaims();
    return res.status(400).send("❌ Claim expiré");
  }

  const twitchURL =
    "https://id.twitch.tv/oauth2/authorize"
    + "?client_id=" + encodeURIComponent(TWITCH_CLIENT_ID)
    + "&redirect_uri=" + encodeURIComponent(TWITCH_REDIRECT)
    + "&response_type=code"
    + "&scope=user:read:chat"
    + "&state=" + encodeURIComponent(claimToken);

  res.redirect(twitchURL);
});

// =======================
// 3) CALLBACK TWITCH
// =======================
app.get("/auth/twitch/callback", async (req, res) => {
  try {
    cleanupExpiredClaims();

    const code = req.query.code;
    const claimToken = req.query.state;

    if (!code || !claimToken) {
      return res.status(400).send("❌ Paramètres manquants");
    }

    const claim = claims.get(claimToken);
    if (!claim) return res.send("❌ Claim invalide");
    if (claim.used) return res.send("❌ Claim déjà utilisé");
    if (claim.expiresAt <= Date.now()) {
      claims.delete(claimToken);
      saveClaims();
      return res.send("❌ Claim expiré");
    }

    const tokenRes = await axios.post("https://id.twitch.tv/oauth2/token", null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: TWITCH_REDIRECT,
      }
    });

    const twitchAccessToken = tokenRes.data.access_token;

    // Validation du token Twitch
    await axios.get("https://id.twitch.tv/oauth2/validate", {
      headers: {
        Authorization: "OAuth " + twitchAccessToken,
      }
    });

    const userRes = await axios.get("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        Authorization: "Bearer " + twitchAccessToken,
      }
    });

    const twitchUser = userRes.data.data[0];
    if (!twitchUser) return res.send("❌ Utilisateur Twitch introuvable");

    const twitchLogin = twitchUser.login.toLowerCase();
    const twitchUserId = String(twitchUser.id);

    // Vérifie que le Twitch connecté est bien celui qui a redeem la récompense
    if (claim.twitchUserId !== twitchUserId || claim.twitchLogin !== twitchLogin) {
      return res.send("❌ Ce compte Twitch ne correspond pas à la récompense utilisée");
    }

    const discordURL = "https://discord.com/api/oauth2/authorize"
      + "?client_id=" + encodeURIComponent(DISCORD_CLIENT_ID)
      + "&redirect_uri=" + encodeURIComponent(DISCORD_REDIRECT)
      + "&response_type=code"
      + "&scope=identify%20guilds.join"
      + "&state=" + encodeURIComponent(claimToken);

    res.redirect(discordURL);
  } catch (err) {
    console.error(err?.response?.data || err);
    res.send("❌ Erreur Twitch");
  }
});

// =======================
// 4) CALLBACK DISCORD
// =======================
app.get("/auth/discord/callback", async (req, res) => {
  try {
    cleanupExpiredClaims();

    const code = req.query.code;
    const claimToken = req.query.state;

    if (!code || !claimToken) {
      return res.status(400).send("❌ Paramètres manquants");
    }

    const claim = claims.get(claimToken);
    if (!claim) return res.send("❌ Claim invalide");
    if (claim.used) return res.send("❌ Claim déjà utilisé");
    if (claim.expiresAt <= Date.now()) {
      claims.delete(claimToken);
      saveClaims();
      return res.send("❌ Claim expiré");
    }

    const params = new URLSearchParams();
    params.append("client_id", DISCORD_CLIENT_ID);
    params.append("client_secret", DISCORD_CLIENT_SECRET);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", DISCORD_REDIRECT);

    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      params,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const discordAccessToken = tokenRes.data.access_token;

    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: {
        Authorization: "Bearer " + discordAccessToken,
      }
    });

    const discordId = String(userRes.data.id);
    const guild = await bot.guilds.fetch(DISCORD_GUILD_ID);

    // Une récompense = un seul Discord
    if (linkedAccounts.has(claim.twitchLogin)) {
      const existing = linkedAccounts.get(claim.twitchLogin);

      let stillInServer = true;
      try {
        await guild.members.fetch(existing);
      } catch {
        stillInServer = false;
      }

      if (!stillInServer) {
        linkedAccounts.delete(claim.twitchLogin);
        saveLinks();
      }

      if (existing !== discordId && stillInServer) {
        return res.send("❌ Ce compte Twitch est déjà lié à un autre Discord encore présent sur le serveur");
      }
    }

    await new Promise(r => setTimeout(r, 500));

    let member;
    try {
      member = await guild.members.fetch(discordId);
    } catch {
      member = null;
    }

    const role = guild.roles.cache.find(r => r.name === ROLE_NAME);
    if (!role) return res.send("❌ Rôle introuvable");

    if (!member) {
      await axios.put(
        `https://discord.com/api/guilds/${DISCORD_GUILD_ID}/members/${discordId}`,
        { access_token: discordAccessToken },
        {
          headers: {
            Authorization: "Bot " + BOT_TOKEN,
            "Content-Type": "application/json",
          }
        }
      );

      member = await guild.members.fetch(discordId);
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
    }

    linkedAccounts.set(claim.twitchLogin, discordId);
    saveLinks();

    claim.used = true;
    claims.set(claimToken, claim);
    saveClaims();

    appendLog({
      type: "claim_consumed",
      twitchUserId: claim.twitchUserId,
      twitchLogin: claim.twitchLogin,
      discordId,
      redemptionId: claim.redemptionId,
      rewardId: claim.rewardId,
    });

    try {
      const channel = await bot.channels.fetch(LOG_CHANNEL_ID);
      if (channel && channel.send) {
        await channel.send(`📊 ${claim.twitchLogin} a utilisé sa récompense et a obtenu l'accès Discord`);
      }
    } catch (e) {
      console.error("Erreur log Discord:", e);
    }

    claims.delete(claimToken);
    saveClaims();

    res.send(`
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
  margin:0;
  height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  background: radial-gradient(circle, #0e0e10, #1f1f23);
  color:white;
  font-family: Arial, sans-serif;
}
.card {
  background: rgba(24,24,27,0.95);
  padding:40px;
  border-radius:20px;
  text-align:center;
  box-shadow:0 0 30px rgba(0,0,0,0.8);
  max-width: 420px;
}
h1 { color:#00ff88; }
p { color:#bbb; }
</style>
</head>
<body>
  <div class="card">
    <h1>🎉 Bienvenue !</h1>
    <p>Ta récompense de points de chaîne a bien été validée.</p>
    <p>Tu as maintenant accès au Discord 🎮</p>
    <p>Tu peux fermer cette page 👌</p>
  </div>
</body>
</html>
`);
  } catch (err) {
    console.error(err?.response?.data || err);
    res.send("❌ Erreur Discord");
  }
});

app.listen(3000, () => {
  console.log("SECURE CHANNEL-POINTS BOT READY");
});

bot.login(BOT_TOKEN);
