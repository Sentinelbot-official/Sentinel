const db = require("./database");
const logger = require("./logger");
const ms = require("ms");

/**
 * Advanced Metrics Collector
 * EXCEEDS LEADING COMPETITOR - Deep analytics on everything
 * Tracks command usage, user engagement, server health, and predictive metrics
 */
class AdvancedMetrics {
  constructor(client) {
    this.client = client;
    this.metricsCache = new Map();
    this.aggregationInterval = null;
    this.realTimeMetrics = {
      commandsPerMinute: 0,
      messagesPerMinute: 0,
      joinsPerMinute: 0,
      leavesPerMinute: 0,
      violationsPerMinute: 0,
    };
  }

  /**
   * Start metrics collection
   */
  start() {
    // Aggregate metrics every 5 minutes (reduced from 1 minute to avoid rate limits)
    this.aggregationInterval = setInterval(() => {
      this.aggregateMetrics();
    }, ms("5m"));

    // Reset real-time counters every 5 minutes
    setInterval(() => {
      this.resetRealTimeCounters();
    }, ms("5m"));

    logger.info("AdvancedMetrics", "📊 Advanced metrics collection started");
  }

  /**
   * Stop metrics collection
   */
  stop() {
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
    }
  }

  /**
   * Track command execution
   */
  async trackCommand(guildId, commandName, userId, executionTime, success) {
    try {
      this.realTimeMetrics.commandsPerMinute++;

      // Store in database
      await db.db.run(
        `INSERT INTO command_metrics (guild_id, command_name, user_id, execution_time, success, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          guildId,
          commandName,
          userId,
          executionTime,
          success ? 1 : 0,
          Date.now(),
        ]
      );

      // Update cache for real-time access
      const cacheKey = `cmd:${guildId}:${commandName}`;
      const cached = this.metricsCache.get(cacheKey) || {
        count: 0,
        totalTime: 0,
        failures: 0,
      };
      cached.count++;
      cached.totalTime += executionTime;
      if (!success) cached.failures++;
      this.metricsCache.set(cacheKey, cached);
    } catch (error) {
      logger.error("AdvancedMetrics", "Error tracking command:", error);
    }
  }

  /**
   * Track user engagement
   */
  async trackEngagement(guildId, userId, eventType, metadata = {}) {
    try {
      this.realTimeMetrics.messagesPerMinute++;

      await db.db.run(
        `INSERT INTO user_engagement (guild_id, user_id, event_type, metadata, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
        [guildId, userId, eventType, JSON.stringify(metadata), Date.now()]
      );
    } catch (error) {
      logger.error("AdvancedMetrics", "Error tracking engagement:", error);
    }
  }

  /**
   * Track server health metrics
   */
  async trackServerHealth(guildId, metrics) {
    try {
      await db.db.run(
        `INSERT INTO server_health_metrics (
          guild_id, member_count, online_count, message_rate, 
          command_rate, violation_rate, avg_response_time, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          guildId,
          metrics.memberCount,
          metrics.onlineCount,
          metrics.messageRate,
          metrics.commandRate,
          metrics.violationRate,
          metrics.avgResponseTime,
          Date.now(),
        ]
      );
    } catch (error) {
      logger.error("AdvancedMetrics", "Error tracking server health:", error);
    }
  }

  /**
   * Track moderation actions
   */
  async trackModeration(guildId, action, moderatorId, targetId, reason) {
    try {
      this.realTimeMetrics.violationsPerMinute++;

      await db.db.run(
        `INSERT INTO moderation_metrics (guild_id, action, moderator_id, target_id, reason, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [guildId, action, moderatorId, targetId, reason, Date.now()]
      );
    } catch (error) {
      logger.error("AdvancedMetrics", "Error tracking moderation:", error);
    }
  }

  /**
   * Get command statistics for a guild
   */
  async getCommandStats(guildId, timeRange = 86400000) {
    // Default 24 hours
    try {
      const since = Date.now() - timeRange;
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT command_name, COUNT(*) as count, AVG(execution_time) as avg_time,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
           FROM command_metrics
           WHERE guild_id = ? AND timestamp > ?
           GROUP BY command_name
           ORDER BY count DESC`,
          [guildId, since],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      return rows;
    } catch (error) {
      logger.error("AdvancedMetrics", "Error getting command stats:", error);
      return [];
    }
  }

  /**
   * Get user engagement score
   */
  async getUserEngagementScore(guildId, userId, timeRange = 604800000) {
    // Default 7 days
    try {
      const since = Date.now() - timeRange;
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as event_count,
           COUNT(DISTINCT DATE(timestamp / 1000, 'unixepoch')) as active_days
           FROM user_engagement
           WHERE guild_id = ? AND user_id = ? AND timestamp > ?`,
          [guildId, userId, since],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!row) return 0;

      // Calculate engagement score (0-100)
      // Based on: events per day * consistency
      const eventsPerDay = row.event_count / 7;
      const consistency = row.active_days / 7;
      const score = Math.min(100, eventsPerDay * 5 + consistency * 50);

      return Math.round(score);
    } catch (error) {
      logger.error(
        "AdvancedMetrics",
        "Error calculating engagement score:",
        error
      );
      return 0;
    }
  }

  /**
   * Get server health overview
   */
  async getServerHealth(guildId) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return null;

      // Get recent metrics
      const recentMetrics = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT * FROM server_health_metrics
           WHERE guild_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`,
          [guildId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      // Calculate health score (0-100)
      let healthScore = 100;

      // Deduct points for high violation rate
      if (recentMetrics?.violation_rate > 10) {
        healthScore -= Math.min(30, recentMetrics.violation_rate);
      }

      // Deduct points for slow response time
      if (recentMetrics?.avg_response_time > 1000) {
        healthScore -= Math.min(
          20,
          (recentMetrics.avg_response_time - 1000) / 100
        );
      }

      // Deduct points for low activity
      if (recentMetrics?.message_rate < 1) {
        healthScore -= 10;
      }

      return {
        score: Math.max(0, Math.round(healthScore)),
        memberCount: guild.memberCount,
        onlineCount: guild.members.cache.filter(
          (m) => m.presence?.status !== "offline"
        ).size,
        messageRate: recentMetrics?.message_rate || 0,
        commandRate: recentMetrics?.command_rate || 0,
        violationRate: recentMetrics?.violation_rate || 0,
        avgResponseTime: recentMetrics?.avg_response_time || 0,
        realTime: this.realTimeMetrics,
      };
    } catch (error) {
      logger.error("AdvancedMetrics", "Error getting server health:", error);
      return null;
    }
  }

  /**
   * Get top users by engagement
   */
  async getTopUsers(guildId, limit = 10, timeRange = 604800000) {
    // Default 7 days
    try {
      const since = Date.now() - timeRange;
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT user_id, COUNT(*) as event_count
           FROM user_engagement
           WHERE guild_id = ? AND timestamp > ?
           GROUP BY user_id
           ORDER BY event_count DESC
           LIMIT ?`,
          [guildId, since, limit],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      return rows;
    } catch (error) {
      logger.error("AdvancedMetrics", "Error getting top users:", error);
      return [];
    }
  }

  /**
   * Get moderation trends
   */
  async getModerationTrends(guildId, timeRange = 2592000000) {
    // Default 30 days
    try {
      const since = Date.now() - timeRange;
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT action, COUNT(*) as count,
           DATE(timestamp / 1000, 'unixepoch') as date
           FROM moderation_metrics
           WHERE guild_id = ? AND timestamp > ?
           GROUP BY action, date
           ORDER BY date DESC`,
          [guildId, since],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      return rows;
    } catch (error) {
      logger.error(
        "AdvancedMetrics",
        "Error getting moderation trends:",
        error
      );
      return [];
    }
  }

  /**
   * Aggregate metrics (called every minute)
   */
  async aggregateMetrics() {
    try {
      for (const guild of this.client.guilds.cache.values()) {
        // Calculate current rates
        const messageRate = this.realTimeMetrics.messagesPerMinute;
        const commandRate = this.realTimeMetrics.commandsPerMinute;
        const violationRate = this.realTimeMetrics.violationsPerMinute;

        // Get average response time from recent commands
        const avgResponseTime = await this.getAverageResponseTime(guild.id);

        // Track server health (now runs every 5 minutes instead of every minute)
        await this.trackServerHealth(guild.id, {
          memberCount: guild.memberCount,
          onlineCount: guild.members.cache.filter(
            (m) => m.presence?.status !== "offline"
          ).size,
          messageRate,
          commandRate,
          violationRate,
          avgResponseTime,
        });
      }
    } catch (error) {
      logger.error("AdvancedMetrics", "Error aggregating metrics:", error);
    }
  }

  /**
   * Get average response time for recent commands
   */
  async getAverageResponseTime(guildId) {
    try {
      const since = Date.now() - 60000; // Last minute
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT AVG(execution_time) as avg_time
           FROM command_metrics
           WHERE guild_id = ? AND timestamp > ?`,
          [guildId, since],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      return row?.avg_time || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Reset real-time counters
   */
  resetRealTimeCounters() {
    this.realTimeMetrics = {
      commandsPerMinute: 0,
      messagesPerMinute: 0,
      joinsPerMinute: 0,
      leavesPerMinute: 0,
      violationsPerMinute: 0,
    };
  }

  /**
   * Get predictive insights
   */
  async getPredictiveInsights(guildId) {
    try {
      const insights = {
        churnRisk: await this.calculateChurnRisk(guildId),
        growthTrend: await this.calculateGrowthTrend(guildId),
        engagementTrend: await this.calculateEngagementTrend(guildId),
        moderationLoad: await this.calculateModerationLoad(guildId),
      };

      return insights;
    } catch (error) {
      logger.error(
        "AdvancedMetrics",
        "Error getting predictive insights:",
        error
      );
      return null;
    }
  }

  /**
   * Calculate churn risk (probability of members leaving)
   */
  async calculateChurnRisk(guildId) {
    try {
      // Get join/leave ratio over last 7 days
      const since = Date.now() - 604800000;
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT 
           SUM(CASE WHEN event_type = 'join' THEN 1 ELSE 0 END) as joins,
           SUM(CASE WHEN event_type = 'leave' THEN 1 ELSE 0 END) as leaves
           FROM user_engagement
           WHERE guild_id = ? AND timestamp > ?`,
          [guildId, since],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!row || row.joins === 0) return "low";

      const ratio = row.leaves / row.joins;
      if (ratio > 0.5) return "high";
      if (ratio > 0.3) return "medium";
      return "low";
    } catch (error) {
      return "unknown";
    }
  }

  /**
   * Calculate growth trend
   */
  async calculateGrowthTrend(guildId) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return "stable";

      // Compare current member count to 7 days ago
      const sevenDaysAgo = Date.now() - 604800000;
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT member_count FROM server_health_metrics
           WHERE guild_id = ? AND timestamp > ?
           ORDER BY timestamp ASC
           LIMIT 1`,
          [guildId, sevenDaysAgo],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!row) return "stable";

      const growth =
        ((guild.memberCount - row.member_count) / row.member_count) * 100;
      if (growth > 5) return "growing";
      if (growth < -5) return "declining";
      return "stable";
    } catch (error) {
      return "stable";
    }
  }

  /**
   * Calculate engagement trend
   */
  async calculateEngagementTrend(guildId) {
    try {
      // Compare message rate now vs 7 days ago
      const now = Date.now();
      const sevenDaysAgo = now - 604800000;

      const recent = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT AVG(message_rate) as avg_rate FROM server_health_metrics
           WHERE guild_id = ? AND timestamp > ?`,
          [guildId, now - 86400000],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      const old = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT AVG(message_rate) as avg_rate FROM server_health_metrics
           WHERE guild_id = ? AND timestamp BETWEEN ? AND ?`,
          [guildId, sevenDaysAgo, sevenDaysAgo + 86400000],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (!recent || !old || old.avg_rate === 0) return "stable";

      const change = ((recent.avg_rate - old.avg_rate) / old.avg_rate) * 100;
      if (change > 10) return "increasing";
      if (change < -10) return "decreasing";
      return "stable";
    } catch (error) {
      return "stable";
    }
  }

  /**
   * Calculate moderation load
   */
  async calculateModerationLoad(guildId) {
    try {
      const since = Date.now() - 86400000; // Last 24 hours
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as count FROM moderation_metrics
           WHERE guild_id = ? AND timestamp > ?`,
          [guildId, since],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      const count = row?.count || 0;
      if (count > 50) return "high";
      if (count > 20) return "medium";
      return "low";
    } catch (error) {
      return "low";
    }
  }
}

module.exports = AdvancedMetrics;
