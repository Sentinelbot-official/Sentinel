const db = require("../utils/database");
const { EmbedBuilder, ChannelType } = require("discord.js");
const ErrorHandler = require("../utils/errorHandler");
const logger = require("../utils/logger");

module.exports = {
  name: "channelCreate",
  async execute(channel, client) {
    // Skip anti-nuke checks if backup restore is in progress
    const backupManager = require("../utils/backupManager");
    if (backupManager.isRestoring(channel.guild.id)) {
      logger.debug(
        `[channelCreate] Skipping anti-nuke check - backup restore in progress for ${channel.guild.id}`
      );
      return; // Don't process during backup restore
    }

    // If server is in lockdown, check who created the channel
    if (
      client.advancedAntiNuke &&
      client.advancedAntiNuke.lockedGuilds.has(channel.guild.id)
    ) {
      // Check who created the channel
      const auditLogs = await channel.guild
        .fetchAuditLogs({
          limit: 1,
          type: 10, // CHANNEL_CREATE
        })
        .catch(() => null);
      const entry = auditLogs?.entries?.first();

      if (entry && entry.executor) {
        const isBot = entry.executor.id === client.user.id;
        const isGuildOwner = entry.executor.id === channel.guild.ownerId;

        // Skip lockdown ONLY for bot and guild owner (NOT whitelisted users during lockdown)
        if (isBot || isGuildOwner) {
          return; // Allow and skip all monitoring
        }
      }

      // Not bot/owner/whitelisted - delete during lockdown
      try {
        await channel
          .delete("Anti-Nuke: Channel created during lockdown")
          .catch(() => {});
        return; // Don't process further
      } catch (error) {
        // Continue to monitoring
      }
    }

    // ULTRA-FAST anti-nuke monitoring - ZERO LATENCY
    if (client.advancedAntiNuke) {
      // Start audit log fetch in background (non-blocking)
      const auditLogPromise = channel.guild
        .fetchAuditLogs({
          limit: 1,
          type: 10, // CHANNEL_CREATE
        })
        .catch(() => null);

      // INSTANT DETECTION: Check recent channel creation rate
      // Track channel creation timestamps per guild
      if (!client.channelCreationTracker) {
        client.channelCreationTracker = new Map();
      }

      const guildId = channel.guild.id;
      if (!client.channelCreationTracker.has(guildId)) {
        client.channelCreationTracker.set(guildId, []);
      }

      const creationHistory = client.channelCreationTracker.get(guildId);
      const now = Date.now();

      // Add current creation
      creationHistory.push({ timestamp: now, channelId: channel.id });

      // Clean old entries (older than 10 seconds)
      const recentCreations = creationHistory.filter(
        (c) => now - c.timestamp < 10000
      );
      client.channelCreationTracker.set(guildId, recentCreations);

      // INSTANT TRIGGER: If 2+ channels created in 10 seconds = RAID
      const isRapidCreation = recentCreations.length >= 2;

      // Also check for obvious raid channel names
      const isRaidChannel =
        channel.name.includes("nuked") ||
        channel.name.includes("raid") ||
        channel.name.includes("hacked") ||
        /^[^a-zA-Z0-9\s-_]{3,}$/.test(channel.name); // Spam characters

      // Get audit log result
      const auditLogs = await auditLogPromise;
      const entry = auditLogs?.entries?.first();

      if (entry && entry.executor) {
        // Skip instant detection for server owner and bot itself
        const isGuildOwner = entry.executor.id === channel.guild.ownerId;
        const isBot = entry.executor.id === client.user.id;

        // Check if user is whitelisted
        const isWhitelisted = client.advancedAntiNuke
          ? await client.advancedAntiNuke.isWhitelisted(
              channel.guild.id,
              entry.executor.id
            )
          : false;

        // Track in event-based tracker
        if (client.eventActionTracker) {
          client.eventActionTracker.trackAction(
            channel.guild.id,
            "CHANNEL_CREATE",
            entry.executor.id,
            { channelId: channel.id, channelName: channel.name }
          );
        }

        // INSTANT RESPONSE: If rapid creation OR raid channel detected (but NOT guild owner/bot)
        // NOTE: Whitelisted users are NOT exempt from raid detection - they can still trigger if they spam
        if ((isRapidCreation || isRaidChannel) && !isGuildOwner && !isBot) {
          // Delete channel immediately
          await channel.delete("Anti-Nuke: Raid detected").catch(() => {});

          // Trigger anti-nuke with HIGH PRIORITY
          await client.advancedAntiNuke.monitorAction(
            channel.guild,
            "channelCreate",
            entry.executor.id,
            {
              channelId: channel.id,
              channelName: channel.name,
              instantTrigger: true, // Force immediate action
              isRaidChannel: true,
              rapidCreation: isRapidCreation,
              creationCount: recentCreations.length,
            }
          );
        } else {
          // Normal monitoring
          if (isGuildOwner) {
            logger.debug(
              `[Anti-Nuke] Skipping instant detection for guild owner ${entry.executor.tag}`
            );
          }

          // Whitelisted users skip NORMAL anti-nuke monitoring (not instant raid detection)
          if (!isWhitelisted) {
            await client.advancedAntiNuke.monitorAction(
              channel.guild,
              "channelCreate",
              entry.executor.id,
              { channelId: channel.id, channelName: channel.name }
            );
          } else {
            logger.debug(
              `[Anti-Nuke] Skipping normal monitoring for whitelisted user ${entry.executor.tag} (but still subject to raid detection)`
            );
          }
        }
      }
    }

    // Enhanced logging
    const EnhancedLogging = require("../utils/enhancedLogging");
    await EnhancedLogging.log(channel.guild.id, "channel_create", "server", {
      userId: null,
      moderatorId: null,
      action: "channel_created",
      details: `Channel created: ${channel.name}`,
      metadata: {
        channelId: channel.id,
        channelName: channel.name,
        channelType: ChannelType[channel.type],
        parentId: channel.parentId,
        nsfw: channel.nsfw,
      },
      severity: "info",
    });

    // Check for mod log channel
    const config = await db.getServerConfig(channel.guild.id);
    if (config && config.mod_log_channel) {
      const logChannel = channel.guild.channels.cache.get(
        config.mod_log_channel
      );
      if (logChannel) {
        const channelTypeNames = {
          [ChannelType.GuildText]: "Text Channel",
          [ChannelType.GuildVoice]: "Voice Channel",
          [ChannelType.GuildCategory]: "Category",
          [ChannelType.GuildAnnouncement]: "Announcement Channel",
          [ChannelType.GuildForum]: "Forum Channel",
          [ChannelType.GuildStageVoice]: "Stage Channel",
        };

        const embed = new EmbedBuilder()
          .setTitle("➕ Channel Created")
          .setDescription(`**${channel.name}** channel was created`)
          .addFields(
            {
              name: "Channel",
              value: `${channel} (${channel.id})`,
              inline: true,
            },
            {
              name: "Type",
              value: channelTypeNames[channel.type] || "Unknown",
              inline: true,
            },
            {
              name: "Category",
              value: channel.parent?.name || "None",
              inline: true,
            },
            {
              name: "NSFW",
              value: channel.nsfw ? "Yes" : "No",
              inline: true,
            }
          )
          .setColor(0x00ff00)
          .setTimestamp();

        logChannel
          .send({ embeds: [embed] })
          .catch(
            ErrorHandler.createSafeCatch(
              `channelCreate [${channel.guild.id}]`,
              `Send mod log for channel create`
            )
          );
      }
    }
  },
};
