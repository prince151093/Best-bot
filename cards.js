const path = require("path");
const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const { vehicles } = require("./vehicles");

const VEHICLE_ASSET_DIR = __dirname;

function hours(seconds) {
  return (Number(seconds || 0) / 3600).toFixed(1);
}

function progressBar(current, required, size = 14) {
  if (!required) return "██████████████";
  const ratio = Math.max(0, Math.min(1, current / required));
  const filled = Math.round(ratio * size);
  return "█".repeat(filled) + "░".repeat(size - filled);
}

function currentVehicle(user) {
  return user.vehicle_index > 0 ? vehicles[user.vehicle_index - 1] : null;
}

function nextVehicle(user) {
  return user.vehicle_index < vehicles.length
    ? vehicles[user.vehicle_index]
    : null;
}

function vehicleFilename(vehicle) {
  return `vehicle-${String(vehicle.id).padStart(2, "0")}.png`;
}

function vehicleImagePath(vehicle) {
  return path.join(VEHICLE_ASSET_DIR, vehicleFilename(vehicle));
}

function vehicleAttachment(vehicle) {
  return new AttachmentBuilder(vehicleImagePath(vehicle), {
    name: vehicleFilename(vehicle)
  });
}

function profileEmbed(member, user) {
  const current = currentVehicle(user);
  const next = nextVehicle(user);

  const embed = new EmbedBuilder()
    .setTitle(`🚗 ${member.displayName}'s Vehicle Life`)
    .setDescription(
      current
        ? `### ${current.emoji} ${current.name}\nYour current ride`
        : "### 🚶 No Vehicle\nStart your journey by being active in the server."
    )
    .addFields(
      {
        name: "🎙️ VC Time",
        value: `${hours(user.vc_seconds)} hours`,
        inline: true
      },
      {
        name: "💬 Messages",
        value: Number(user.messages || 0).toLocaleString(),
        inline: true
      },
      {
        name: "🚗 Vehicles",
        value: `${user.vehicle_index} / ${vehicles.length}`,
        inline: true
      }
    )
    .setColor(0x168cff)
    .setFooter({
      text: "Vehicle Life • Be active. Build your garage."
    });

  if (current) {
    embed.setImage(`attachment://${vehicleFilename(current)}`);
  }

  if (next) {
    const vc = Number(user.vc_seconds || 0) / 3600;
    const vcPct = Math.min(
      100,
      Math.floor((vc / next.vcHours) * 100)
    );
    const msgPct = Math.min(
      100,
      Math.floor((Number(user.messages || 0) / next.messages) * 100)
    );

    embed.addFields({
      name: `🔒 Next: ${next.emoji} ${next.name}`,
      value:
        `🎙️ ${next.vcHours}h VC • ${vcPct}%\n` +
        `💬 ${next.messages.toLocaleString()} messages • ${msgPct}%\n` +
        `\`${progressBar(vc, next.vcHours)}\` VC`
    });
  } else {
    embed.addFields({
      name: "🏆 Collection Complete",
      value: "You have unlocked every vehicle!"
    });
  }

  return embed;
}

function profileFiles(user) {
  const current = currentVehicle(user);
  return current ? [vehicleAttachment(current)] : [];
}

function garagePage(member, user, page = 0, perPage = 4) {
  const owned = vehicles.slice(
    0,
    Math.min(user.vehicle_index, vehicles.length)
  );

  const pageCount = Math.max(1, Math.ceil(owned.length / perPage));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const pageVehicles = owned.slice(
    safePage * perPage,
    safePage * perPage + perPage
  );

  const embeds = pageVehicles.map(vehicle =>
    new EmbedBuilder()
      .setTitle(`${vehicle.emoji} ${vehicle.name}`)
      .setDescription(
        `**Vehicle #${vehicle.id}** • ${vehicle.category.toUpperCase()}\n` +
        `✅ Owned and unlocked`
      )
      .setImage(`attachment://${vehicleFilename(vehicle)}`)
      .setColor(0x168cff)
      .setFooter({
        text: `${member.displayName}'s Garage • Page ${safePage + 1}/${pageCount}`
      })
  );

  if (!embeds.length) {
    embeds.push(
      new EmbedBuilder()
        .setTitle(`🏁 ${member.displayName.toUpperCase()}'S GARAGE`)
        .setDescription(
          "🚶 You do not own any vehicles yet. Stay active to unlock your first vehicle!"
        )
        .setColor(0x168cff)
        .setFooter({
          text: "Vehicle Life • Your collection, your journey."
        })
    );
  }

  return {
    embeds,
    files: pageVehicles.map(vehicleAttachment),
    page: safePage,
    pageCount,
    totalOwned: owned.length
  };
}

function topGaragesEmbed(rows, guild) {
  const lines = rows.map((u, i) => {
    const v = currentVehicle(u);
    return (
      `**#${i + 1} • ${v ? `${v.emoji} ${v.name}` : "🚶 No Vehicle"}**\n` +
      `<@${u.user_id}> • **${u.vehicle_index}/${vehicles.length}** vehicles • ` +
      `🎙️ ${hours(u.vc_seconds)}h • 💬 ${u.messages.toLocaleString()}`
    );
  });

  return new EmbedBuilder()
    .setTitle("🏆 TOP GARAGES")
    .setDescription(lines.join("\n\n") || "No players yet.")
    .setColor(0x168cff)
    .setFooter({ text: `${guild.name} • Vehicle Life` })
    .setTimestamp();
}

module.exports = {
  profileEmbed,
  profileFiles,
  garagePage,
  topGaragesEmbed,
  currentVehicle,
  nextVehicle,
  vehicleAttachment
};
