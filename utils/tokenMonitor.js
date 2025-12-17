/**
 * Discord Bot Token Usage Monitor
 * Tracks bot activity patterns to detect unauthorized token usage
 * EXCEEDS WICK - Advanced token security monitoring
 */

const logger = require("./logger");
const db = require("./database");

class TokenMonitor {
  constructor(client) {
    this.client = client;
    this.activityLog = [];
    this.maxLogSize = 10000; // Keep last 10k activities
    this.suspiciousPatterns = [];
    this.knownIPs = new Set(); // Track known connection IPs (if available)
    this.connectionHistory = [];
    this.maxHistorySize = 1000;

    // Baseline patterns (learned from normal usage)
    this.baseline = {
      averageCommandsPerHour: 0,
      peakHours: [],
      commonGuilds: new Set(),
      commandDistribution: new Map(),
    };

    // Alert thresholds
    this.thresholds = {
      unusualCommandSpike: 3, // 3x normal rate
      newGuildActivity: true, // Alert on new guild activity
      simultaneousConnections: 1, // Alert if >1 shard connects from different IPs
      rateLimitViolations: 5, // Alert after 5 rate limit hits
      offHoursActivity: true, // Alert on activity during unusual hours
    };

    this.startTime = Date.now();
    this.alertWebhook = process.env.TOKEN_MONITOR_WEBHOOK || null;
  }

  /**
   * Initialize monitoring
   */
  init() {
    // Monitor client events
    this.client.on("ready", () => this.onBotReady());
    this.client.on("shardReady", (id) => this.onShardReady(id));
    this.client.on("shardDisconnect", (event, id) =>
      this.onShardDisconnect(event, id)
    );
    this.client.on("shardReconnecting", (id) => this.onShardReconnecting(id));
    this.client.on("rateLimit", (rateLimitInfo) =>
      this.onRateLimit(rateLimitInfo)
    );
    this.client.on("error", (error) => this.onError(error));
    this.client.on("warn", (warning) => this.onWarning(warning));

    // Monitor command executions
    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isCommand()) {
        this.trackCommand(interaction);
      }
    });

    // Monitor guild activity
    this.client.on("guildCreate", (guild) => this.trackGuildActivity(guild));
    this.client.on("guildDelete", (guild) => this.trackGuildActivity(guild));

    // Periodic analysis
    setInterval(() => this.analyzePatterns(), 5 * 60 * 1000); // Every 5 minutes
    setInterval(() => this.cleanupOldLogs(), 60 * 60 * 1000); // Every hour

    logger.success("TokenMonitor", "Token usage monitoring initialized");
  }

  /**
   * Track a command execution
   */
  trackCommand(interaction) {
    const activity = {
      type: "command",
      command: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      timestamp: Date.now(),
      shardId: interaction.guild?.shardId || 0,
    };

    this.logActivity(activity);
    this.updateBaseline(activity);
  }

  /**
   * Track guild activity
   */
  trackGuildActivity(guild) {
    const activity = {
      type: "guild_change",
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount,
      timestamp: Date.now(),
      shardId: guild.shardId || 0,
    };

    this.logActivity(activity);
    this.checkSuspiciousGuildActivity(activity);
  }

  /**
   * Log activity
   */
  logActivity(activity) {
    this.activityLog.push(activity);

    // Maintain log size
    if (this.activityLog.length > this.maxLogSize) {
      this.activityLog.shift();
    }

    // Store in database for long-term analysis
    this.storeActivity(activity).catch((err) => {
      logger.debug("TokenMonitor", `Failed to store activity: ${err.message}`);
    });
  }

  /**
   * Store activity in database
   */
  async storeActivity(activity) {
    return new Promise((resolve, reject) => {
      db.db.run(
        `INSERT INTO token_activity_logs 
         (activity_type, command_name, guild_id, user_id, shard_id, metadata, timestamp) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          activity.type,
          activity.command || null,
          activity.guildId || null,
          activity.userId || null,
          activity.shardId || 0,
          JSON.stringify(activity),
          activity.timestamp,
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /**
   * Update baseline patterns
   */
  updateBaseline(activity) {
    if (activity.type === "command") {
      const count =
        this.baseline.commandDistribution.get(activity.command) || 0;
      this.baseline.commandDistribution.set(activity.command, count + 1);

      if (activity.guildId) {
        this.baseline.commonGuilds.add(activity.guildId);
      }
    }
  }

  /**
   * Check for suspicious guild activity
   */
  checkSuspiciousGuildActivity(activity) {
    // Alert if bot joins/leaves guilds unexpectedly
    if (
      this.thresholds.newGuildActivity &&
      !this.baseline.commonGuilds.has(activity.guildId)
    ) {
      this.triggerAlert("new_guild_activity", {
        message: `Bot ${activity.type === "guild_create" ? "joined" : "left"} new guild: ${activity.guildName} (${activity.guildId})`,
        guildId: activity.guildId,
        guildName: activity.guildName,
        timestamp: activity.timestamp,
      });
    }
  }

  /**
   * Handle bot ready event
   */
  onBotReady() {
    const connection = {
      type: "ready",
      timestamp: Date.now(),
      shardId: "all",
      guildCount: this.client.guilds.cache.size,
      userCount: this.client.users.cache.size,
    };

    this.connectionHistory.push(connection);
    if (this.connectionHistory.length > this.maxHistorySize) {
      this.connectionHistory.shift();
    }

    this.logActivity({
      type: "connection",
      event: "ready",
      timestamp: Date.now(),
    });
  }

  /**
   * Handle shard ready
   */
  onShardReady(shardId) {
    const connection = {
      type: "shard_ready",
      shardId,
      timestamp: Date.now(),
    };

    this.connectionHistory.push(connection);
    this.checkSimultaneousConnections();
  }

  /**
   * Handle shard disconnect
   */
  onShardDisconnect(event, shardId) {
    this.logActivity({
      type: "connection",
      event: "shard_disconnect",
      shardId,
      code: event.code,
      reason: event.reason,
      timestamp: Date.now(),
    });

    // Alert on unexpected disconnects
    if (event.code !== 1000 && event.code !== 1001) {
      // Not normal closure
      this.triggerAlert("unexpected_disconnect", {
        shardId,
        code: event.code,
        reason: event.reason,
      });
    }
  }

  /**
   * Handle shard reconnecting
   */
  onShardReconnecting(shardId) {
    this.logActivity({
      type: "connection",
      event: "shard_reconnecting",
      shardId,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle rate limit
   */
  onRateLimit(rateLimitInfo) {
    this.logActivity({
      type: "rate_limit",
      route: rateLimitInfo.route,
      limit: rateLimitInfo.limit,
      timeToReset: rateLimitInfo.timeToReset,
      timestamp: Date.now(),
    });

    // Check for suspicious rate limit patterns
    const recentRateLimits = this.activityLog.filter(
      (a) =>
        a.type === "rate_limit" &&
        Date.now() - a.timestamp < 60 * 60 * 1000 // Last hour
    );

    if (recentRateLimits.length >= this.thresholds.rateLimitViolations) {
      this.triggerAlert("excessive_rate_limits", {
        count: recentRateLimits.length,
        routes: recentRateLimits.map((r) => r.route),
      });
    }
  }

  /**
   * Handle errors
   */
  onError(error) {
    this.logActivity({
      type: "error",
      error: error.message,
      stack: error.stack?.substring(0, 500), // Truncate stack
      timestamp: Date.now(),
    });
  }

  /**
   * Handle warnings
   */
  onWarning(warning) {
    this.logActivity({
      type: "warning",
      warning: warning.toString(),
      timestamp: Date.now(),
    });
  }

  /**
   * Check for simultaneous connections from different locations
   */
  checkSimultaneousConnections() {
    const recentConnections = this.connectionHistory.filter(
      (c) => Date.now() - c.timestamp < 5 * 60 * 1000 // Last 5 minutes
    );

    const uniqueShards = new Set(
      recentConnections.map((c) => c.shardId).filter((id) => id !== "all")
    );

    // If we have more shards connecting than expected, alert
    const expectedShards = this.client.shard?.count || 1;
    if (uniqueShards.size > expectedShards) {
      this.triggerAlert("suspicious_shard_activity", {
        expected: expectedShards,
        detected: uniqueShards.size,
        shards: Array.from(uniqueShards),
      });
    }
  }

  /**
   * Analyze patterns for anomalies
   */
  analyzePatterns() {
    const now = Date.now();
    const lastHour = now - 60 * 60 * 1000;

    // Get activities from last hour
    const recentActivities = this.activityLog.filter(
      (a) => a.timestamp >= lastHour
    );

    // Check for command spikes
    const commands = recentActivities.filter((a) => a.type === "command");
    const commandCount = commands.length;

    if (this.baseline.averageCommandsPerHour > 0) {
      const spikeThreshold =
        this.baseline.averageCommandsPerHour *
        this.thresholds.unusualCommandSpike;

      if (commandCount > spikeThreshold) {
        this.triggerAlert("command_spike", {
          normal: this.baseline.averageCommandsPerHour,
          detected: commandCount,
          multiplier: (commandCount / this.baseline.averageCommandsPerHour).toFixed(2),
        });
      }
    } else {
      // First time, set baseline
      this.baseline.averageCommandsPerHour = commandCount;
    }

    // Check for unusual command distribution
    const commandDist = new Map();
    commands.forEach((c) => {
      commandDist.set(c.command, (commandDist.get(c.command) || 0) + 1);
    });

    // Alert if a rarely-used command suddenly spikes
    for (const [cmd, count] of commandDist.entries()) {
      const baselineCount =
        this.baseline.commandDistribution.get(cmd) || 0;
      const baselineTotal = Array.from(
        this.baseline.commandDistribution.values()
      ).reduce((a, b) => a + b, 1);

      const baselineRatio = baselineCount / baselineTotal;
      const currentRatio = count / commandCount;

      if (
        baselineRatio > 0 &&
        currentRatio > baselineRatio * 5 &&
        count > 10
      ) {
        this.triggerAlert("unusual_command_pattern", {
          command: cmd,
          baselineRatio: (baselineRatio * 100).toFixed(2) + "%",
          currentRatio: (currentRatio * 100).toFixed(2) + "%",
          count,
        });
      }
    }

    // Check for off-hours activity (if configured)
    if (this.thresholds.offHoursActivity) {
      const hour = new Date().getHours();
      // Define "normal hours" as 8 AM - 11 PM
      if (hour < 8 || hour > 23) {
        if (commandCount > 50) {
          // Significant activity during off-hours
          this.triggerAlert("off_hours_activity", {
            hour,
            commandCount,
          });
        }
      }
    }
  }

  /**
   * Trigger security alert
   */
  async triggerAlert(alertType, details) {
    const alert = {
      type: alertType,
      severity: this.getAlertSeverity(alertType),
      details,
      timestamp: Date.now(),
      botUptime: Math.floor((Date.now() - this.startTime) / 1000),
    };

    this.suspiciousPatterns.push(alert);
    if (this.suspiciousPatterns.length > 100) {
      this.suspiciousPatterns.shift();
    }

    // Log to database
    await db.logSecurityEvent(
      "system",
      "token_monitor",
      null,
      JSON.stringify(alert),
      70, // Threat score
      alertType
    ).catch(() => {});

    // Send webhook alert if configured
    if (this.alertWebhook) {
      this.sendWebhookAlert(alert).catch((err) => {
        logger.debug("TokenMonitor", `Failed to send webhook: ${err.message}`);
      });
    }

    logger.warn("TokenMonitor", `Alert: ${alertType}`, details);
  }

  /**
   * Get alert severity
   */
  getAlertSeverity(alertType) {
    const severityMap = {
      command_spike: "medium",
      unusual_command_pattern: "medium",
      new_guild_activity: "low",
      excessive_rate_limits: "high",
      unexpected_disconnect: "medium",
      suspicious_shard_activity: "high",
      off_hours_activity: "low",
    };

    return severityMap[alertType] || "low";
  }

  /**
   * Send webhook alert
   */
  async sendWebhookAlert(alert) {
    const axios = require("axios");
    const embed = {
      title: `🔒 Token Security Alert: ${alert.type}`,
      description: `**Severity:** ${alert.severity.toUpperCase()}\n**Time:** <t:${Math.floor(alert.timestamp / 1000)}:R>`,
      fields: Object.entries(alert.details).map(([key, value]) => ({
        name: key.replace(/_/g, " ").toUpperCase(),
        value: String(value),
        inline: true,
      })),
      color: alert.severity === "high" ? 0xff0000 : alert.severity === "medium" ? 0xffa500 : 0xffff00,
      timestamp: new Date(alert.timestamp).toISOString(),
    };

    await axios.post(this.alertWebhook, {
      embeds: [embed],
    });
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const last24h = Date.now() - 24 * 60 * 60 * 1000;
    const recentActivities = this.activityLog.filter(
      (a) => a.timestamp >= last24h
    );

    return {
      uptime,
      totalActivities: this.activityLog.length,
      activitiesLast24h: recentActivities.length,
      suspiciousPatterns: this.suspiciousPatterns.length,
      recentAlerts: this.suspiciousPatterns.slice(-10),
      baseline: {
        averageCommandsPerHour: this.baseline.averageCommandsPerHour,
        commonGuilds: this.baseline.commonGuilds.size,
        topCommands: Array.from(this.baseline.commandDistribution.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([cmd, count]) => ({ command: cmd, count })),
      },
    };
  }

  /**
   * Cleanup old logs
   */
  cleanupOldLogs() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days

    // Clean in-memory logs
    this.activityLog = this.activityLog.filter((a) => a.timestamp >= cutoff);

    // Clean database logs (older than 30 days)
    const dbCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.db.run(
      `DELETE FROM token_activity_logs WHERE timestamp < ?`,
      [dbCutoff],
      (err) => {
        if (err) {
          logger.debug("TokenMonitor", `Failed to cleanup DB logs: ${err.message}`);
        }
      }
    );
  }
}

module.exports = TokenMonitor;

