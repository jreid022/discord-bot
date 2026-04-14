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
const TWITCH_CLIENT_ID = "zfjwt5c5ke9tao5xuv1zk478isc0ez";
const TWITCH_CLIENT_SECRET = "22jlscbgqrvza5kdy9gzoh7fx5hfu3";
const DISCORD_CLIENT_ID = "1493588782795198525";
const DISCORD_CLIENT_SECRET = "9ll3DdUwdVlEGiDobnVlrhZxM453aOYS";
const BOT_TOKEN = process.env.BOT_TOKEN;

const TWITCH_REDIRECT = "http://localhost:3000/auth/twitch/callback";
const DISCORD_REDIRECT = "http://localhost:3000/auth/discord/callback";

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

      try {
        await guild.members.fetch(existing);
        if (existing !== discordId) {
          return res.send("❌ Déjà lié à un autre Discord");
        }
      } catch {
        linkedAccounts.set(twitchUser, discordId);
      }
    }

    // ➕ JOIN SI BESOIN
    await guild.members.fetch();

    let member = guild.members.cache.get(discordId);

    if (!member) {
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

      member = await guild.members.fetch(discordId);
    }

    // 🎭 ROLE
    const role = guild.roles.cache.find(r => r.name === ROLE_NAME);
    if (!role) return res.send("❌ Rôle introuvable");

    await member.roles.add(role);

    // 💾 SAVE
    linkedAccounts.set(twitchUser, discordId);
    fs.writeFileSync("links.json", JSON.stringify([...linkedAccounts]));

    pending.delete(token);

    res.send("🎉 Accès Discord activé automatiquement !");

  } catch (err) {
    console.error(err);
    res.send("❌ Erreur Discord");
  }
});

// =======================
// 🚀 START
// =======================
app.listen(3000, () => {
  console.log("SYSTÈME ULTIME PRÊT");
});

bot.login(BOT_TOKEN);
