const { ActivityType } = require("discord.js");
const ShardManager = require("../utils/shardManager");
const { registerCommands } = require("../utils/registerCommands");
const logger = require("../utils/logger");
const databaseBackup = require("../utils/databaseBackup");
const rateLimitHandler = require("../utils/rateLimitHandler");
const autoScaling = require("../utils/autoScaling");
const shardErrorTracker = require("../utils/shardErrorTracker");
const ms = require("ms");

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    const shardInfo = ShardManager.getShardInfo(client);

    // Register slash commands with timeout protection
    try {
      const registrationPromise = registerCommands(client);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("Command registration timeout after 2 minutes")),
          120000
        )
      );

      await Promise.race([registrationPromise, timeoutPromise]).catch(
        (error) => {
          logger.error(
            "Ready",
            `Command registration failed or timed out: ${error.message}`
          );
          // Continue anyway - bot should still work
        }
      );
    } catch (error) {
      logger.error("Ready", "Critical error in command registration:", error);
      // Continue anyway
    }

    // Post commands to Discord Bot List (only from shard 0 or non-sharded)
    if (process.env.DISCORDBOTLIST_TOKEN) {
      const shardInfo = ShardManager.getShardInfo(client);
      const shouldPostCommands =
        !shardInfo.isSharded || shardInfo.shardId === 0;

      if (shouldPostCommands) {
        try {
          const DiscordBotList = require("../utils/discordbotlist");
          let dbl = client.discordBotList;

          if (!dbl) {
            dbl = new DiscordBotList(client, process.env.DISCORDBOTLIST_TOKEN);
            // Initialize it (this sets up the dbl instance)
            dbl.initialize();
            client.discordBotList = dbl;
          }

          // Collect all commands
          const commands = [];
          for (const command of client.commands.values()) {
            if (command.data) {
              commands.push(command.data.toJSON());
            }
          }

          if (commands.length > 0) {
            await dbl.postCommands(commands);
            logger.info(
              "Ready",
              `Posted ${commands.length} commands to Discord Bot List`
            );
          }
        } catch (error) {
          logger.error(
            "Ready",
            "Failed to post commands to Discord Bot List",
            error
          );
        }
      }
    }

    if (shardInfo.isSharded) {
      logger.info(
        "Ready",
        `✅ Shard ${shardInfo.shardId}/${shardInfo.shardCount - 1} is online!`
      );
      const shardUserCount = client.guilds.cache.reduce(
        (acc, guild) => acc + guild.memberCount,
        0
      );
      logger.info(
        "Ready",
        `📊 Serving ${client.guilds.cache.size} servers on this shard`
      );
      logger.info("Ready", `👥 Watching ${shardUserCount} users on this shard`);
    } else {
      const totalUserCount = client.guilds.cache.reduce(
        (acc, guild) => acc + guild.memberCount,
        0
      );
      logger.info("Ready", `✅ ${client.user.tag} is online!`);
      logger.info("Ready", `📊 Serving ${client.guilds.cache.size} servers`);
      logger.info("Ready", `👥 Watching ${totalUserCount} users`);
    }

    // Initialize channel pins cache for pin/unpin tracking (if not already initialized)
    if (!client.channelPins) {
      client.channelPins = new Map();
    }

    // List all guilds
    logger.info("Ready", `\n📋 Guilds (${client.guilds.cache.size}):`);
    const guilds = Array.from(client.guilds.cache.values()).sort(
      (a, b) => (b.memberCount || 0) - (a.memberCount || 0)
    );
    guilds.forEach((guild, index) => {
      const memberCount = guild.memberCount || 0;
      const owner = guild.members.cache.get(guild.ownerId);
      const ownerTag = owner?.user?.tag || "Unknown";
      logger.info(
        "Ready",
        `  ${index + 1}. ${guild.name} (${
          guild.id
        }) - ${memberCount} members - Owner: ${ownerTag}`
      );
    });

    // Get total stats if sharded
    if (shardInfo.isSharded) {
      try {
        const totalGuilds = await ShardManager.getGuildCount(client);
        const totalUsers = await ShardManager.getUserCount(client);
        logger.info(
          "Ready",
          `🌐 Total across all shards: ${totalGuilds} servers, ${totalUsers} users`
        );
      } catch (error) {
        logger.error("Ready", "Failed to fetch shard stats", {
          message: error?.message || String(error),
          stack: error?.stack,
          name: error?.name,
        });
      }
    }

    // Set bot status
    client.user.setActivity(
      shardInfo.isSharded
        ? `${client.guilds.cache.size} servers | discord.gg/9vQzqBVMNX | /help`
        : "discord.gg/9vQzqBVMNX | /help",
      {
        type: ActivityType.Watching,
      }
    );

    // Load workflows for all guilds
    if (client.workflows) {
      for (const guild of client.guilds.cache.values()) {
        await client.workflows.loadWorkflows(guild.id);
      }
    }

    // Start automatic snapshot scheduler ( - point-in-time recovery)
    if (
      client.snapshotScheduler &&
      (!shardInfo.isSharded || shardInfo.shardId === 0)
    ) {
      client.snapshotScheduler.start();
      logger.info(
        "Ready",
        "📸 Snapshot scheduler started (hourly backups enabled)"
      );
    }

    // Start token scanner (proactive monitoring of paste sites)
    if (client.tokenScanner) {
      client.tokenScanner.startScanning();
      logger.info(
        "Ready",
        "🔍 Token scanner started (monitoring paste sites every 5 minutes)"
      );
    }

    // Start automatic vote checking for all guilds ( - auto vote rewards)
    if (client.voteRewards) {
      for (const guild of client.guilds.cache.values()) {
        client.voteRewards.startAutoChecking(guild);
      }
    }

    // Start Dashboard Server ( - free dashboard vs Competition's premium)
    if (
      client.dashboardServer &&
      (!shardInfo.isSharded || shardInfo.shardId === 0)
    ) {
      const port = process.env.PORT || 3000;
      client.dashboardServer.start(port);
      logger.info("Ready", `🌐 Dashboard server started on port ${port}`);
      logger.info(
        "Ready",
        `🔗 Access at: ${process.env.DASHBOARD_URL || `http://localhost:${port}`}`
      );
    }

    // Start Scheduled Actions System ( - automation)
    if (
      client.scheduledActions &&
      (!shardInfo.isSharded || shardInfo.shardId === 0)
    ) {
      await client.scheduledActions.start();
    }

    // Start Advanced AI & Intelligence Systems ( - next-gen)
    if (!shardInfo.isSharded || shardInfo.shardId === 0) {
      if (client.advancedMetrics) {
        client.advancedMetrics.start();
      }

      if (client.mlTrainer) {
        client.mlTrainer.start();
        await client.mlTrainer.loadAllModels();
      }

      if (client.retentionPredictor) {
        client.retentionPredictor.start();
      }

      if (client.threatCorrelation) {
        client.threatCorrelation.start();
      }
    }

    // Generate initial recommendations for all guilds
    const SmartRecommendations = require("../utils/smartRecommendations");
    for (const guild of client.guilds.cache.values()) {
      try {
        await SmartRecommendations.analyzeServer(guild.id, guild);
      } catch (error) {
        logger.error(
          "Ready",
          `Failed to generate recommendations for ${guild.name}`,
          error
        );
      }
    }

    // Initialize default configs for all servers
    client.guilds.cache.forEach((guild) => {
      if (!client.antiRaid.config.has(guild.id)) {
        client.antiRaid.config.set(guild.id, {
          enabled: true,
          maxJoins: 5,
          timeWindow: 10000,
          action: "ban",
          antiNuke: true,
          quarantineRole: null,
        });
      }
    });

    // Event-based action tracking (replaces audit log monitor - no rate limits!)
    if (client.eventActionTracker) {
      logger.info(
        "Ready",
        `Event-based action tracking initialized (no periodic polling - uses Discord events)`
      );

      // Set up periodic cleanup for action cache (every 10 minutes)
      setInterval(() => {
        if (client.eventActionTracker) {
          client.eventActionTracker.cleanup();
        }
      }, ms("10m"));
    }

    // Create recovery snapshots for all servers (if auto-recovery is enabled)
    // Process in batches for better performance
    const AutoRecovery = require("../utils/autoRecovery");
    const db = client.db;
    const allGuilds = Array.from(client.guilds.cache.values());
    const batchSize = 5;

    for (let i = 0; i < allGuilds.length; i += batchSize) {
      const batch = allGuilds.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (guild) => {
          try {
            const config = await db.getServerConfig(guild.id);
            // Default to enabled if not set
            if (config?.auto_recovery_enabled !== 0) {
              // Check if we have a recent snapshot (within last 24 hours)
              const recentSnapshots = await db.getRecoverySnapshots(
                guild.id,
                1
              );
              const hasRecentSnapshot =
                recentSnapshots.length > 0 &&
                Date.now() - recentSnapshots[0].created_at <
                  24 * 60 * 60 * 1000;

              if (!hasRecentSnapshot) {
                await AutoRecovery.autoSnapshot(
                  guild,
                  "Periodic auto-snapshot",
                  true // Fetch fresh data for periodic snapshots
                );
                logger.info(
                  "Ready",
                  `Created recovery snapshot for ${guild.name}`
                );
              }
            }
          } catch (error) {
            // Silently continue - not critical
            logger.debug(
              "Ready",
              `Failed to create snapshot for ${guild.name}`,
              {
                message: error?.message || String(error),
                stack: error?.stack,
                name: error?.name,
              }
            );
          }
        })
      );
    }

    // Check bot role position in all servers (warn if not high enough)
    for (const guild of client.guilds.cache.values()) {
      try {
        const botMember = await guild.members
          .fetch(client.user.id)
          .catch(() => null);
        if (!botMember) {
          continue;
        }

        const botRole = botMember.roles.highest;
        if (!botRole) {
          continue;
        }
      } catch (error) {
        // Silently continue - not critical
      }
    }

    // Initialize bot list stats posting (for non-sharded mode only)
    // DO NOT initialize if sharding is enabled - shard.js handles it
    if (!process.env.USING_SHARDING && !shardInfo.isSharded) {
      // Initialize Void Bots stats posting
      if (process.env.VOIDBOTS_TOKEN && !client.voidBots) {
        try {
          const VoidBots = require("../utils/voidbots");
          const voidBots = new VoidBots(client, process.env.VOIDBOTS_TOKEN);
          voidBots.initialize();
          client.voidBots = voidBots;
        } catch (error) {
          logger.error("[Void Bots] Failed to initialize:", error);
        }
      }

      // Initialize Botlist.me stats posting
      if (process.env.BOTLISTME_TOKEN && !client.botListMe) {
        try {
          const BotListMe = require("../utils/botlistme");
          const botListMe = new BotListMe(client, process.env.BOTLISTME_TOKEN);
          botListMe.initialize();
          client.botListMe = botListMe;
        } catch (error) {
          logger.error("[Botlist.me] Failed to initialize:", error);
        }
      }

      // Initialize Discord Bots (discord.bots.gg) stats posting
      if (process.env.DISCORDBOTS_TOKEN && !client.discordBots) {
        try {
          const DiscordBots = require("../utils/discordbots");
          const discordBots = new DiscordBots(
            client,
            process.env.DISCORDBOTS_TOKEN
          );
          discordBots.initialize();
          client.discordBots = discordBots;
        } catch (error) {
          logger.error("[Discord Bots] Failed to initialize:", error);
        }
      }

      // Initialize Bots on Discord stats posting
      if (process.env.BOTSONDICORD_TOKEN && !client.botsOnDiscord) {
        try {
          const BotsOnDiscord = require("../utils/botsondicord");
          const botsOnDiscord = new BotsOnDiscord(
            client,
            process.env.BOTSONDICORD_TOKEN
          );
          botsOnDiscord.initialize();
          client.botsOnDiscord = botsOnDiscord;
        } catch (error) {
          logger.error("[Bots on Discord] Failed to initialize:", error);
        }
      }
    }

    // Start database backup schedule (only on shard 0 or non-sharded)
    const shouldStartBackup = !shardInfo.isSharded || shardInfo.shardId === 0;
    if (shouldStartBackup) {
      try {
        databaseBackup.startSchedule();

        // Start auto-scaling monitor (checks every hour)
        autoScaling.startMonitoring(client, 3600000);

        // Start shard error tracker cleanup
        shardErrorTracker.startCleanup();

        // Initialize rate limit handler
        rateLimitHandler.initialize(client);
        logger.info("Ready", "⏱️  Rate limit protection enabled");
      } catch (error) {
        logger.error("Ready", "Failed to start database backup", {
          message: error?.message || String(error),
        });
      }
    }
  },
};
