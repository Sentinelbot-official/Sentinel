const { ClusterManager } = require("discord-hybrid-sharding");
const path = require("path");
require("dotenv").config();
const logger = require("./utils/logger");

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN not found in .env file!");
  process.exit(1);
}

// Cluster configuration
const totalClusters = parseInt(process.env.CLUSTERS) || "auto"; // Auto-calculate or use env var
const shardsPerCluster = parseInt(process.env.SHARDS_PER_CLUSTER) || 3; // 3 shards per cluster (optimal for most cases)

const manager = new ClusterManager(path.join(__dirname, "shard.js"), {
  totalShards: "auto", // Let Discord decide shard count
  totalClusters: totalClusters, // Auto-calculate cluster count or use env var
  shardsPerClusters: shardsPerCluster,
  mode: "process", // or "worker" (process is more stable)
  token: process.env.DISCORD_TOKEN,
  execArgv: process.execArgv,
});

const { getClusterDisplay } = require("./utils/shardNames");

// Cluster events
manager.on("clusterCreate", (cluster) => {
  const clusterName = getClusterDisplay(cluster.id);
  logger.info("Cluster", `✅ Launched ${clusterName}`);

  cluster.on("clientReady", () => {
    logger.success("Cluster", `🟢 ${clusterName} is ready!`);
  });

  cluster.on("disconnect", () => {
    logger.warn("Cluster", `🔴 ${clusterName} disconnected`);
  });

  cluster.on("reconnecting", () => {
    logger.info("Cluster", `🟡 ${clusterName} reconnecting...`);
  });

  cluster.on("death", () => {
    // Check if token leak shutdown flag exists
    const fs = require("fs");
    if (fs.existsSync("./.TOKEN_LEAK_SHUTDOWN")) {
      logger.error(
        "Cluster",
        `💀 ${clusterName} died due to TOKEN LEAK - NOT RESPAWNING`
      );
      logger.error("Cluster", `🚨 MANUAL ACTION REQUIRED:`);
      logger.error(
        "Cluster",
        `   1. Regenerate bot token at https://discord.com/developers/applications`
      );
      logger.error("Cluster", `   2. Update .env with new token`);
      logger.error("Cluster", `   3. Delete .TOKEN_LEAK_SHUTDOWN file`);
      logger.error("Cluster", `   4. Restart bot manually`);

      // Don't respawn - exit the entire cluster manager
      process.exit(1);
    }

    logger.error("Cluster", `💀 ${clusterName} died, respawning...`);
  });

  cluster.on("error", (error) => {
    console.error(`❌ ${clusterName} error:`, error);

    // Track error
    const clusterErrorTracker = require("./utils/clusterErrorTracker");
    clusterErrorTracker.trackError(cluster.id, error, {
      event: "clusterError",
    });
  });

  cluster.on("message", (message) => {
    // Handle inter-cluster communication
    if (message._type === "stats") {
      logger.info(
        `📊 ${clusterName} - ${message.guilds} guilds, ${message.users} users`
      );
    }
  });
});

manager
  .spawn({ timeout: -1 })
  .then(() => {
    // Start cluster health monitoring after all clusters are spawned
    const clusterHealthMonitor = require("./utils/clusterHealthMonitor");
    clusterHealthMonitor.start(manager);
    logger.info("Cluster", "✅ Cluster health monitoring active");

    // Start error tracker cleanup
    const clusterErrorTracker = require("./utils/clusterErrorTracker");
    clusterErrorTracker.startCleanup();
    logger.info("Cluster", "✅ Cluster error tracking started");
  })
  .catch(console.error);

// Graceful shutdown with parallel cluster termination (EXCEEDS WICK - faster shutdown)
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down clusters gracefully...`);

  // Stop health monitoring
  try {
    const clusterHealthMonitor = require("./utils/clusterHealthMonitor");
    clusterHealthMonitor.stop();
  } catch (err) {
    // Ignore if not initialized
  }

  // Stop error tracker cleanup
  try {
    const clusterErrorTracker = require("./utils/clusterErrorTracker");
    clusterErrorTracker.stopCleanup();
  } catch (err) {
    // Ignore if not initialized
  }

  // Kill all clusters in parallel for faster shutdown
  const killPromises = Array.from(manager.clusters.values()).map((cluster) => {
    return new Promise((resolve) => {
      try {
        cluster.kill();
        resolve();
      } catch (error) {
        console.error(`Error killing cluster ${cluster.id}:`, error);
        resolve(); // Continue even if one fails
      }
    });
  });

  await Promise.all(killPromises);
  logger.info("All clusters terminated.");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Cluster manager stats
manager.on("debug", (info) => {
  if (process.env.DEBUG === "true") {
    logger.info(`[DEBUG] ${info}`);
  }
});

// Get total stats across all clusters
async function getTotalStats() {
  try {
    const results = await manager.broadcastEval((c) => {
      return {
        guilds: c.guilds.cache.size,
        users: c.users.cache.size,
        channels: c.channels.cache.size,
      };
    });

    const total = results.reduce(
      (acc, val) => {
        acc.guilds += val.guilds;
        acc.users += val.users;
        acc.channels += val.channels;
        return acc;
      },
      { guilds: 0, users: 0, channels: 0 }
    );

    return total;
  } catch (error) {
    console.error("Error getting total stats:", error);
    return null;
  }
}

// Log total stats every 30 minutes
setInterval(
  async () => {
    const stats = await getTotalStats();
    if (stats) {
      logger.info(
        `\n📊 [Total Stats] ${stats.guilds} guilds, ${stats.users} users, ${stats.channels} channels across ${manager.totalClusters} clusters\n`
      );
    }
  },
  30 * 60 * 1000
);

logger.info(`\n🚀 Cluster Manager Started`);
logger.info(
  `📊 Clusters: ${totalClusters === "auto" ? "Auto" : totalClusters}`
);
logger.info(`⚙️  Shards per cluster: ${shardsPerCluster}`);
logger.info(`🔄 Mode: process`);
logger.info(`\n`);
