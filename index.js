/* Vehicle Life — game-only Discord bot */
const http = require("http");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const config = require("./config");
const vehicleGame = require("./game");
const competitive = require("./competitive");
const { init: initDb, close: closeDb, getUser } = require("./db");
const { ensureRacerRole } = require("./server-settings");

if (!config.token) {
  console.error("Missing DISCORD_TOKEN environment variable.");
  process.exit(1);
}
if (!config.clientId) {
  console.error("Missing CLIENT_ID environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let healthServer = null;

function startHealthServer() {
  const port = Number(process.env.PORT);
  if (!port) return;

  healthServer = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Vehicle Life is running\n");
      return;
    }
    res.writeHead(404);
    res.end("Not found\n");
  });

  healthServer.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });
}

startHealthServer();

const commands = [
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View your Vehicle Life profile"),

  new SlashCommandBuilder()
    .setName("garage")
    .setDescription("View your Vehicle Life garage"),

  new SlashCommandBuilder()
    .setName("viewgarage")
    .setDescription("View another member's Vehicle Life garage")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("Member whose garage you want to view")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("topgarages")
    .setDescription("Show the Vehicle Life leaderboard")
].map(command => command.toJSON());

async function deployCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);

  const body = commands;

  if (config.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body }
    );
    console.log("Vehicle Life guild slash commands registered.");
  } else {
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body }
    );
    console.log("Vehicle Life global slash commands registered.");
  }
}

client.on("error", error => console.error("DISCORD CLIENT ERROR:", error));
client.on("warn", warning => console.warn("DISCORD CLIENT WARNING:", warning));

client.once("clientReady", async () => {
  console.log(`DISCORD READY: Logged in as ${client.user.tag}`);
  console.log(`Vehicle Life is online in ${client.guilds.cache.size} server(s).`);

  try {
    await initDb();
    await deployCommands();
    await vehicleGame.startAutomation(client);
    await competitive.startCompetitiveAutomation(client);
    console.log("Vehicle Life automation started.");
  } catch (error) {
    console.error("Vehicle Life startup error:", error);
  }
});

/*
 * Vehicle Life prefix commands only.
 * The separate Server/Activity bot owns moderation, message counting,
 * VC tracking and all other server-management commands.
 */
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  try {
    const competitiveResult = await competitive.handleCommand(message);
    if (competitiveResult) return;

    await vehicleGame.handle(message);
  } catch (error) {
    console.error("Vehicle Life message command error:", error);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isButton()) {
      const competitiveResult = await competitive.handleButton(interaction);
      if (competitiveResult) return;

      const gameResult = await vehicleGame.handleButton(interaction);
      if (gameResult) return;
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const gid = interaction.guildId;
    const uid = interaction.user.id;
    if (!gid) {
      await interaction.reply({
        content: "Vehicle Life commands can only be used inside a server.",
        ephemeral: true
      });
      return;
    }

    await ensureRacerRole(interaction.member).catch(() => null);
    await vehicleGame.syncPlayerProgression(gid, uid);

    if (interaction.commandName === "profile") {
      await interaction.deferReply();
      const profile = await vehicleGame.profile(gid, uid);
      const owned = await vehicleGame.vehiclesOf(gid, uid);
      const activity = getUser(uid, gid);
      const best = owned
        .map(o => vehicleGame.vehicles[o.vehicle_id - 1])
        .filter(Boolean)
        .sort((a, b) => (b.performance || 0) - (a.performance || 0))[0];

      const { profileEmbed, profileFiles } = require("./cards");
      return interaction.editReply({
        embeds: [profileEmbed(interaction.member, { ...activity, gameProfile: profile, gameOwned: owned }, owned, profile)],
        files: profileFiles({ ...activity, gameProfile: profile, gameOwned: owned })
      });
    }

    if (interaction.commandName === "garage") {
      await interaction.deferReply();
      return interaction.editReply({
        content: "🚗 Use `?garage` to open your complete Vehicle Life garage."
      });
    }

    if (interaction.commandName === "viewgarage") {
      await interaction.deferReply();
      const target = interaction.options.getUser("user", true);
      const owned = await vehicleGame.vehiclesOf(gid, target.id);
      return interaction.editReply({
        content: `🚗 <@${target.id}> owns **${owned.length}/${vehicleGame.vehicles.length}** vehicles.\nUse \`?garage\` from that account for the full garage view.`
      });
    }

    if (interaction.commandName === "topgarages") {
      await interaction.deferReply();
      const rows = await vehicleGame.getTopGarages(gid, 10);

      if (!rows.length) {
        return interaction.editReply("🏆 No Vehicle Life collections yet.");
      }

      const lines = rows.map((x, i) => {
        const best = x.best ? `${x.best.emoji} ${x.best.name}` : "No vehicle";
        return `**#${i + 1}** • <@${x.user_id}> • **${x.owned.length}/${vehicleGame.vehicles.length}** vehicles • Best: ${best}`;
      });

      return interaction.editReply({
        content: `🏆 **VEHICLE LIFE — TOP GARAGES**\n\n${lines.join("\n")}`
      });
    }
  } catch (error) {
    console.error("Vehicle Life interaction error:", error);

    const payload = {
      content: "❌ Something went wrong while processing that Vehicle Life action.",
      ephemeral: true
    };

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down Vehicle Life...`);

  try {
    await closeDb();
  } catch (error) {
    console.error("Database shutdown error:", error);
  }

  try {
    client.destroy();
  } catch (_) {}

  try {
    healthServer?.close();
  } catch (_) {}

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

client.login(config.token).catch(error => {
  console.error("Discord login failed:", error);
  process.exit(1);
});
