// =======================
// 📦 IMPORTS
// =======================
const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");

const app = express();

// =======================
// 🔐 CONFIG (REMPLACE TOUT)
// =======================
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN;

const TWITCH_REDIRECT = "https://discord-bot-production-87ea.up.railway.app/auth/twitch/callback";
const DISCORD_REDIRECT = "https://discord-bot-production-87ea.up.railway.app/auth/discord/callback";

const DISCORD_GUILD_ID = "668490005051736094";
const ROLE_NAME = "Marvien";

// =======================
// 🧠 STOCKAGE
// =======================
let linkedAccounts = new Map();

if (fs.existsSync("links.json")) {
  const data = JSON.parse(fs.readFileSync("links.json"));
  linkedAccounts = new Map(data);
}

let pending = new Map();

// =======================
// 🤖 BOT DISCORD
// =======================
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

// =======================
// 🔗 LOGIN TWITCH
// =======================
app.get("/login", (req, res) => {
  const user = req.query.user;

  // 🔐 token unique
  const token = crypto.randomBytes(16).toString("hex");

  pending.set(token, {
    user,
    createdAt: Date.now()
  });

  const url = "https://id.twitch.tv/oauth2/authorize"
    + "?client_id=" + TWITCH_CLIENT_ID
    + "&redirect_uri=" + TWITCH_REDIRECT
    + "&response_type=code"
    + "&scope=user:read:email"
    + "&state=" + token;

  res.redirect(url);
});

// =======================
// 🔁 CALLBACK TWITCH
// =======================
app.get("/auth/twitch/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const token = req.query.state;

    // 🔒 Vérifier token
    const data = pending.get(token);

    if (!data) return res.send("❌ Lien invalide");

    // ⏱ expiration (2 minutes)
    if (Date.now() - data.createdAt > 2 * 60 * 1000) {
      pending.delete(token);
      return res.send("❌ Lien expiré");
    }

    const tokenRes = await axios.post("https://id.twitch.tv/oauth2/token", null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: TWITCH_REDIRECT
      }
    });

    const access_token = tokenRes.data.access_token;

    const userRes = await axios.get("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": "Bearer " + access_token
      }
    });

    const twitchUser = userRes.data.data[0].login.toLowerCase();

    // 🔒 vérifier que c'est le bon utilisateur
    if (data.user.toLowerCase() !== twitchUser) {
      return res.send("❌ Non autorisé");
    }

    // 🔄 on garde twitchUser + createdAt
    pending.set(token, {
      twitchUser: twitchUser,
      createdAt: data.createdAt
    });

    const discordURL = "https://discord.com/api/oauth2/authorize"
      + "?client_id=" + DISCORD_CLIENT_ID
      + "&redirect_uri=" + DISCORD_REDIRECT
      + "&response_type=code"
      + "&scope=identify%20guilds.join"
      + "&state=" + token;

    res.redirect(discordURL);

  } catch (err) {
    console.error(err);
    res.send("❌ Erreur Twitch");
  }
});

// =======================
// 🔁 CALLBACK DISCORD
// =======================
app.get("/auth/discord/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const token = req.query.state;

    const data = pending.get(token);
    if (!data) return res.send("❌ Token invalide");

    const twitchUser = data.twitchUser;

    // 🔑 TOKEN DISCORD
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

    const access_token = tokenRes.data.access_token;

    // 👤 USER DISCORD
    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: {
        Authorization: "Bearer " + access_token
      }
    });

    const discordId = userRes.data.id;

    const guild = await bot.guilds.fetch(DISCORD_GUILD_ID);

  // 🔒 SECURITE
if (linkedAccounts.has(twitchUser)) {
  const existing = linkedAccounts.get(twitchUser);

  let stillInServer = true;

  try {
    await guild.members.fetch(existing);
  } catch {
    stillInServer = false;
  }

  // 🔄 RESET AUTO si quitté serveur
  if (!stillInServer) {
    console.log("♻️ Reset : utilisateur a quitté le serveur");

    linkedAccounts.delete(twitchUser);
    fs.writeFileSync("links.json", JSON.stringify([...linkedAccounts]));
  }

  // ❌ déjà lié à un autre Discord encore présent
  if (existing !== discordId && stillInServer) {
    return res.send("❌ Déjà lié à un autre Discord");
  }
}

// ➕ JOIN SI BESOIN
await guild.members.fetch();

let member = guild.members.cache.get(discordId);
const role = guild.roles.cache.find(r => r.name === ROLE_NAME);
if (!role) return res.send("❌ Rôle introuvable");

// 🔵 Déjà dans le serveur
if (member) {
  console.log("✅ Déjà dans le serveur");

  if (!member.roles.cache.has(role.id)) {
    await member.roles.add(role);
    console.log("🎭 Rôle ajouté à un membre existant");

    return res.send("✅ Tu étais déjà dans le serveur, rôle ajouté !");
  }

  return res.send("✅ Tu es déjà dans le serveur !");
}

// 🟢 Pas dans le serveur → on ajoute
console.log("➕ Ajout au serveur");

await axios.put(
  "https://discord.com/api/guilds/" + DISCORD_GUILD_ID + "/members/" + discordId,
  { access_token: access_token },
  {
    headers: {
      Authorization: "Bot " + BOT_TOKEN,
      "Content-Type": "application/json"
    }
  }
);

// 🔄 récupérer après ajout
member = await guild.members.fetch(discordId);

// 🎭 ROLE
await member.roles.add(role);
console.log(`🎭 Rôle donné à ${twitchUser}`);

// 🔔 LOG DISCORD
const channel = await bot.channels.fetch("849687556865130506");
channel.send(`📊 ${twitchUser} vient de rejoindre le serveur`);

// 💾 SAVE
linkedAccounts.set(twitchUser, discordId);
fs.writeFileSync("links.json", JSON.stringify([...linkedAccounts]));

// 📊 LOG
let logs = [];

try {
  logs = JSON.parse(fs.readFileSync("logs.json"));
} catch {
  logs = [];
}

logs.push({
  twitch: twitchUser,
  discord: discordId,
  date: new Date().toISOString()
});

fs.writeFileSync("logs.json", JSON.stringify(logs, null, 2));

pending.delete(token);

res.send("🎉 Accès Discord activé automatiquement !");
  } catch (err) {
    console.error(err);
    res.send("❌ Erreur Discord");
  }
});

// =======================
// 🚀 START (UNE SEULE FOIS)
// =======================
app.listen(3000, () => {
  console.log("SYSTÈME ULTIME PRÊT");
});

bot.login(BOT_TOKEN);