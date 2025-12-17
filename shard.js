const { ShardingManager } = require("discord.js");
const path = require("path");
require("dotenv").config();

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN not found in .env file!");
  process.exit(1);
}

// Parse token to extract real token if it contains tracking fingerprint
const TokenMonitor = require("./utils/tokenMonitor");
const logger = require("./utils/logger");

// Get token and trim whitespace (common issue)
let rawToken = (process.env.DISCORD_TOKEN || "").trim();
let realToken = rawToken;
let trackingFingerprint = null;

if (!rawToken) {
  console.error("❌ DISCORD_TOKEN not found in .env file!");
  process.exit(1);
}

// Debug: Show token info (first/last chars only for security)
console.log(`🔍 [ShardManager] Token length: ${rawToken.length} chars`);
console.log(`🔍 [ShardManager] Token starts with: ${rawToken.substring(0, 20)}...`);
console.log(`🔍 [ShardManager] Token ends with: ...${rawToken.substring(rawToken.length - 20)}`);
console.log(`🔍 [ShardManager] Has NEXUS_TRACKING_ prefix: ${rawToken.startsWith("NEXUS_TRACKING_")}`);

try {
  const parsed = TokenMonitor.parseToken(rawToken);
  realToken = parsed.realToken || rawToken;
  trackingFingerprint = parsed.trackingFingerprint;
  
  // Log if tracking fingerprint was found
  if (parsed.trackingFingerprint) {
    console.log(`✅ [ShardManager] Tracking fingerprint extracted: ${parsed.trackingFingerprint.substring(0, 8)}...`);
    console.log(`✅ [ShardManager] Real token length: ${realToken.length} chars`);
    console.log(`✅ [ShardManager] Real token preview: ${realToken.substring(0, 20)}...`);
  } else {
    console.log(`⚠️ [ShardManager] No tracking fingerprint found - using token as-is`);
    console.log(`⚠️ [ShardManager] Token length: ${realToken.length} chars`);
    
    // Validate token format
    if (realToken.length < 50) {
      console.error(`❌ [ShardManager] Token too short (${realToken.length} chars). Discord tokens are usually 59-70 chars.`);
    } else if (!/^[A-Za-z0-9._-]+$/.test(realToken)) {
      console.error(`❌ [ShardManager] Token contains invalid characters`);
      console.error(`❌ [ShardManager] Token should only contain: A-Z, a-z, 0-9, ., _, -`);
    } else if (realToken.length > 100) {
      console.error(`❌ [ShardManager] Token too long (${realToken.length} chars). Discord tokens are usually 59-70 chars.`);
    } else {
      console.log(`✅ [ShardManager] Token format looks valid`);
      console.log(`💡 [ShardManager] To add tracking, use format: NEXUS_TRACKING_[FINGERPRINT][REAL_TOKEN]`);
      console.log(`💡 [ShardManager] Example: NEXUS_TRACKING_JHGGJSGSJS762863936${realToken.substring(0, 20)}...`);
    }
  }
} catch (error) {
  console.error(`❌ [ShardManager] Error parsing token: ${error.message}`);
  console.error(`❌ [ShardManager] Stack: ${error.stack}`);
  // Fall back to original token
  realToken = rawToken;
}

// Final validation before passing to ShardingManager
console.log(`🔍 [ShardManager] Final token being used: length=${realToken.length}, preview=${realToken.substring(0, 20)}...`);
if (realToken.length < 50 || realToken.length > 100) {
  console.error(`❌ [ShardManager] Token length ${realToken.length} is outside normal Discord token range (50-100 chars)`);
}
if (!/^[A-Za-z0-9._-]+$/.test(realToken)) {
  console.error(`❌ [ShardManager] Token contains invalid characters`);
}

const manager = new ShardingManager(path.join(__dirname, "index.js"), {
  token: process.env.DISCORD_TOKEN,
  totalShards: "auto", // Auto-calculate shard count
  respawn: true, // Auto-respawn shards if they crash
  execArgv: process.execArgv,
  env: {
    ...process.env,
    USING_SHARDING: "true", // Pass to child processes
  },
});

// Initialize Top.gg stats posting (if token is provided)
if (process.env.TOPGG_TOKEN) {
  try {
    const { AutoPoster } = require("topgg-autoposter");
    // Post every 60 minutes (3600000ms) to avoid rate limits
    // Top.gg allows updates every 30min, but 60min is safer
    const ap = AutoPoster(process.env.TOPGG_TOKEN, manager, {
      interval: 3600000, // 1 hour in milliseconds
    });

    ap.on("posted", (stats) => {
      console.log(
        `📊 [Top.gg] Posted stats: ${stats.serverCount} servers, ${stats.shardCount} shards`
      );
    });

    ap.on("error", (error) => {
      const errorMsg = error.message || error.toString();

      // Suppress common non-critical errors
      if (errorMsg.includes("429")) {
        console.log("⚠️ [Top.gg] Rate limited (429) - will retry in 1 hour");
      } else if (
        errorMsg.includes("504") ||
        errorMsg.includes("Gateway Timeout")
      ) {
        console.log(
          "⚠️ [Top.gg] Gateway timeout (504) - Top.gg API slow, will retry in 1 hour"
        );
      } else if (
        errorMsg.includes("503") ||
        errorMsg.includes("Service Unavailable")
      ) {
        console.log(
          "⚠️ [Top.gg] Service unavailable (503) - will retry in 1 hour"
        );
      } else {
        // Only log actual errors (connection issues, auth problems, etc.)
        console.error("❌ [Top.gg] Error posting stats:", error.message);
      }
    });

    console.log("✅ [Top.gg] Stats posting initialized (60min interval)");
  } catch (error) {
    console.error("❌ [Top.gg] Failed to initialize:", error.message);
  }
} else {
  console.log("ℹ️  [Top.gg] No TOPGG_TOKEN found, skipping stats posting");
}

// Initialize Discord Bot List stats posting (if token is provided)
// Note: The package doesn't directly support ShardingManager, so we'll use manual posting
if (process.env.DISCORDBOTLIST_TOKEN) {
  let dblInterval = null;
  let botId = null;

  // Wait for manager to be ready, then start posting stats
  manager.once("shardCreate", async (shard) => {
    shard.once("clientReady", async () => {
      if (!botId) {
        try {
          // Get bot ID from the first ready shard
          const clientValues = await manager.fetchClientValues("user.id");
          botId = clientValues[0];
        } catch (error) {
          console.error(
            "❌ [Discord Bot List] Failed to get bot ID:",
            error.message
          );
          return;
        }
      }

      if (!dblInterval) {
        const postStats = async () => {
          try {
            const axios = require("axios");
            const guilds = await manager.fetchClientValues("guilds.cache.size");
            const totalGuilds = guilds.reduce((acc, count) => acc + count, 0);

            const users = await manager.broadcastEval((c) =>
              c.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)
            );
            const totalUsers = users.reduce((acc, count) => acc + count, 0);

            // Get voice connections count (number of voice channels the bot is connected to)
            const voiceConnections = await manager.broadcastEval((c) => {
              // Count active voice connections
              let count = 0;
              if (c.voice && c.voice.adapters) {
                count = c.voice.adapters.size;
              }
              return count;
            });
            const totalVoiceConnections = voiceConnections.reduce(
              (acc, count) => acc + count,
              0
            );

            // Post aggregated stats (no shard_id for aggregated posting)
            const payload = {
              guilds: totalGuilds,
              users: totalUsers,
            };

            // Add voice connections if available
            if (totalVoiceConnections > 0) {
              payload.voice_connections = totalVoiceConnections;
            }

            await axios.post(
              `https://discordbotlist.com/api/v1/bots/${botId}/stats`,
              payload,
              {
                headers: {
                  Authorization: process.env.DISCORDBOTLIST_TOKEN,
                  "Content-Type": "application/json",
                },
              }
            );

            console.log(
              `📊 [Discord Bot List] Posted stats: ${totalGuilds} guilds, ${totalUsers} users${
                totalVoiceConnections > 0
                  ? `, ${totalVoiceConnections} voice connections`
                  : ""
              }, ${manager.totalShards} shards`
            );
          } catch (error) {
            console.error(
              "❌ [Discord Bot List] Error posting stats:",
              error.message
            );
            if (error.response) {
              console.error(
                `❌ [Discord Bot List] API Error: ${
                  error.response.status
                } - ${JSON.stringify(error.response.data)}`
              );
            }
          }
        };

        // Post immediately, then set interval
        postStats();
        dblInterval = setInterval(postStats, 3600000); // Every hour

        console.log("✅ [Discord Bot List] Stats posting initialized");
      }
    });
  });
} else {
  console.log(
    "ℹ️  [Discord Bot List] No DISCORDBOTLIST_TOKEN found, skipping stats posting"
  );
}

// Initialize VoidBots stats posting (if token is provided)
// Note: For sharded mode, we'll use manual posting since the package doesn't directly support ShardingManager
if (process.env.VOIDBOTS_TOKEN) {
  let voidbotsInterval = null;
  let botId = null;
  let voidbotsInitialized = false;
  let lastPostTime = 0; // Module-level to persist across restarts
  let isPosting = false; // Module-level lock
  const MIN_POST_INTERVAL = 200000; // 3 minutes 20 seconds - add buffer to be safe (200000ms)

  const postStats = async () => {
    // Prevent concurrent execution - CRITICAL
    if (isPosting) {
      return;
    }

    // Rate limiting: ensure at least 3 minutes between posts
    const now = Date.now();
    const timeSinceLastPost = now - lastPostTime;

    if (timeSinceLastPost < MIN_POST_INTERVAL && lastPostTime > 0) {
      const waitTime = MIN_POST_INTERVAL - timeSinceLastPost;
      console.log(
        `⏳ [VoidBots] Rate limited, waiting ${Math.ceil(
          waitTime / 1000
        )}s before posting...`
      );
      if (voidbotsInterval) {
        clearInterval(voidbotsInterval);
        voidbotsInterval = null;
      }
      setTimeout(() => {
        postStats();
        if (!voidbotsInterval) {
          voidbotsInterval = setInterval(postStats, 15 * 60 * 1000);
        }
      }, waitTime);
      return;
    }

    isPosting = true;
    try {
      const axios = require("axios");
      const guilds = await manager.fetchClientValues("guilds.cache.size");
      const totalGuilds = guilds.reduce((acc, count) => acc + count, 0);
      const shardCount = manager.totalShards;

      await axios.post(
        `https://api.voidbots.net/bot/stats/${botId}`,
        {
          server_count: totalGuilds,
          shard_count: shardCount,
        },
        {
          headers: {
            Authorization: process.env.VOIDBOTS_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );

      lastPostTime = Date.now();
      console.log(
        `📊 [VoidBots] Posted stats: ${totalGuilds} servers, ${shardCount} shards`
      );
      isPosting = false;

      // Restart interval if it was cleared
      if (!voidbotsInterval) {
        voidbotsInterval = setInterval(postStats, 15 * 60 * 1000);
      }
    } catch (error) {
      isPosting = false;
      console.error("❌ [VoidBots] Error posting stats:", error.message);
      if (error.response) {
        console.error(
          `❌ [VoidBots] API Error: ${error.response.status} - ${JSON.stringify(
            error.response.data
          )}`
        );

        // If rate limited (429), clear interval and wait before retrying
        if (error.response.status === 429) {
          if (voidbotsInterval) {
            clearInterval(voidbotsInterval);
            voidbotsInterval = null;
          }
          const retryAfter = error.response.headers["retry-after"]
            ? parseInt(error.response.headers["retry-after"]) * 1000
            : MIN_POST_INTERVAL;
          console.log(
            `⏳ [VoidBots] Rate limited, waiting ${
              retryAfter / 1000
            }s before retry...`
          );
          // DON'T update lastPostTime here - we didn't actually post!
          // Only update it when we successfully post
          // Use a longer retry to be safe (add 10 seconds buffer)
          const safeRetryAfter =
            Math.max(retryAfter, MIN_POST_INTERVAL) + 10000;
          setTimeout(() => {
            postStats();
            if (!voidbotsInterval) {
              voidbotsInterval = setInterval(postStats, 15 * 60 * 1000);
            }
          }, safeRetryAfter);
          return;
        }
      }
    }
  };

  // Initialize only once when first shard is ready
  manager.once("shardCreate", async (shard) => {
    shard.once("clientReady", async () => {
      if (voidbotsInitialized) {
        return;
      }

      if (!botId) {
        try {
          const clientValues = await manager.fetchClientValues("user.id");
          botId = clientValues[0];
        } catch (error) {
          console.error("❌ [VoidBots] Failed to get bot ID:", error.message);
          return;
        }
      }

      voidbotsInitialized = true;

      // Calculate initial delay - if we posted recently, wait the full interval
      const now = Date.now();
      const timeSinceLastPost = now - lastPostTime;
      const initialDelay =
        lastPostTime > 0 && timeSinceLastPost < MIN_POST_INTERVAL
          ? MIN_POST_INTERVAL - timeSinceLastPost + 10000 // Add 10s buffer
          : MIN_POST_INTERVAL;

      console.log(
        `✅ [VoidBots] Stats posting initialized (first post in ${Math.ceil(
          initialDelay / 1000
        )}s)`
      );

      setTimeout(() => {
        postStats();
        if (!voidbotsInterval) {
          voidbotsInterval = setInterval(postStats, 15 * 60 * 1000);
        }
      }, initialDelay);
    });
  });
} else {
  console.log("ℹ️  [VoidBots] No VOIDBOTS_TOKEN found, skipping stats posting");
}

// Initialize Discord Bots (discord.bots.gg) stats posting
if (process.env.DISCORDBOTS_TOKEN) {
  let dbInterval = null;
  let botId = null;

  manager.once("shardCreate", async (shard) => {
    shard.once("clientReady", async () => {
      if (!botId) {
        try {
          const clientValues = await manager.fetchClientValues("user.id");
          botId = clientValues[0];
        } catch (error) {
          console.error("[Discord Bots] Failed to get bot ID:", error.message);
          return;
        }
      }

      if (!dbInterval) {
        const postStats = async () => {
          try {
            const axios = require("axios");
            const guilds = await manager.fetchClientValues("guilds.cache.size");
            const totalGuilds = guilds.reduce((acc, count) => acc + count, 0);

            await axios.post(
              `https://discord.bots.gg/api/v1/bots/${botId}/stats`,
              {
                guildCount: totalGuilds,
                shardCount: manager.totalShards,
              },
              {
                headers: {
                  Authorization: process.env.DISCORDBOTS_TOKEN,
                  "Content-Type": "application/json",
                },
              }
            );

            console.log(
              `📊 [Discord Bots] Posted stats: ${totalGuilds} guilds, ${manager.totalShards} shards`
            );
          } catch (error) {
            console.error("[Discord Bots] Error posting stats:", error.message);
          }
        };

        postStats();
        dbInterval = setInterval(postStats, 1800000); // Every 30 minutes
        console.log("✅ [Discord Bots] Stats posting initialized");
      }
    });
  });
} else {
  console.log(
    "ℹ️  [Discord Bots] No DISCORDBOTS_TOKEN found, skipping stats posting"
  );
}

// Initialize Bots on Discord stats posting
if (process.env.BOTSONDICORD_TOKEN) {
  let bodInterval = null;
  let botId = null;

  manager.once("shardCreate", async (shard) => {
    shard.once("clientReady", async () => {
      if (!botId) {
        try {
          const clientValues = await manager.fetchClientValues("user.id");
          botId = clientValues[0];
        } catch (error) {
          console.error(
            "[Bots on Discord] Failed to get bot ID:",
            error.message
          );
          return;
        }
      }

      if (!bodInterval) {
        const postStats = async () => {
          try {
            const axios = require("axios");
            const guilds = await manager.fetchClientValues("guilds.cache.size");
            const totalGuilds = guilds.reduce((acc, count) => acc + count, 0);

            await axios.post(
              `https://bots.ondiscord.xyz/bot-api/bots/${botId}/guilds`,
              {
                guildCount: totalGuilds,
              },
              {
                headers: {
                  Authorization: process.env.BOTSONDICORD_TOKEN,
                  "Content-Type": "application/json",
                },
              }
            );

            console.log(
              `📊 [Bots on Discord] Posted stats: ${totalGuilds} guilds`
            );
          } catch (error) {
            console.error(
              "[Bots on Discord] Error posting stats:",
              error.message
            );
          }
        };

        postStats();
        bodInterval = setInterval(postStats, 1800000); // Every 30 minutes
        console.log("✅ [Bots on Discord] Stats posting initialized");
      }
    });
  });
} else {
  console.log(
    "ℹ️  [Bots on Discord] No BOTSONDICORD_TOKEN found, skipping stats posting"
  );
}

// Initialize Top.gg webhook server (runs once, not per shard)
// The webhook server will be started in index.js when shard 0 is ready

const { getShardDisplay } = require("./utils/shardNames");

manager.on("shardCreate", (shard) => {
  const shardName = getShardDisplay(shard.id);
  console.log(`✅ Launched ${shardName}`);

  shard.on("clientReady", () => {
    console.log(`🟢 ${shardName} is ready!`);
  });

  shard.on("disconnect", () => {
    console.log(`🔴 ${shardName} disconnected`);
  });

  shard.on("reconnecting", () => {
    console.log(`🟡 ${shardName} reconnecting...`);
  });

  shard.on("death", () => {
    console.log(`💀 ${shardName} died, respawning...`);
  });

  shard.on("error", (error) => {
    console.error(`❌ ${shardName} error:`, error);
  });
});

manager
  .spawn()
  .then(() => {
    // Start shard health monitoring after all shards are spawned
    const shardHealthMonitor = require("./utils/shardHealthMonitor");
    shardHealthMonitor.start(manager);
    console.log("✅ Shard health monitoring active");
  })
  .catch(console.error);

// Graceful shutdown with parallel shard termination (EXCEEDS WICK - faster shutdown)
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down shards gracefully...`);

  // Stop health monitoring
  try {
    const shardHealthMonitor = require("./utils/shardHealthMonitor");
    shardHealthMonitor.stop();
  } catch (err) {
    // Ignore if not initialized
  }

  // Kill all shards in parallel for faster shutdown
  const killPromises = Array.from(manager.shards.values()).map((shard) => {
    return new Promise((resolve) => {
      try {
        shard.kill();
        resolve();
      } catch (error) {
        console.error(`Error killing shard ${shard.id}:`, error);
        resolve(); // Continue even if one fails
      }
    });
  });

  await Promise.all(killPromises);
  console.log("All shards terminated.");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
