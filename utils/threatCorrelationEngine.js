const db = require("./database");
const logger = require("./logger");

/**
 * Real-Time Threat Correlation Engine
 * EXCEEDS WICK - Cross-references threats across all servers in real-time
 * Identifies coordinated attacks, bot networks, and emerging threat patterns
 */
class ThreatCorrelationEngine {
  constructor(client) {
    this.client = client;
    this.threatCache = new Map(); // Recent threats for fast correlation
    this.correlationInterval = null;
    this.alertThreshold = 3; // Min servers affected to trigger alert
    this.timeWindow = 300000; // 5 minutes
  }

  /**
   * Start correlation engine
   */
  start() {
    // Run correlation analysis every minute
    this.correlationInterval = setInterval(() => {
      this.analyzeCorrelations();
    }, 60000);

    // Clean old threats every 5 minutes
    setInterval(() => {
      this.cleanOldThreats();
    }, 300000);

    logger.info(
      "ThreatCorrelationEngine",
      "🔗 Threat correlation engine started"
    );
  }

  /**
   * Stop correlation engine
   */
  stop() {
    if (this.correlationInterval) {
      clearInterval(this.correlationInterval);
    }
  }

  /**
   * Report a threat for correlation
   */
  async reportThreat(threat) {
    try {
      const {
        guildId,
        userId,
        type,
        severity,
        metadata = {},
        timestamp = Date.now(),
      } = threat;

      // Store in cache for fast correlation
      const cacheKey = `${userId}-${type}`;
      const cached = this.threatCache.get(cacheKey) || {
        userId,
        type,
        guilds: new Set(),
        occurrences: [],
        firstSeen: timestamp,
        lastSeen: timestamp,
      };

      cached.guilds.add(guildId);
      cached.occurrences.push({
        guildId,
        severity,
        metadata,
        timestamp,
      });
      cached.lastSeen = timestamp;

      this.threatCache.set(cacheKey, cached);

      // Store in database
      await this.storeThreat(threat);

      // Check for immediate correlation
      if (cached.guilds.size >= this.alertThreshold) {
        await this.triggerCorrelationAlert(cached);
      }
    } catch (error) {
      logger.error("ThreatCorrelationEngine", "Error reporting threat:", error);
    }
  }

  /**
   * Store threat in database
   */
  async storeThreat(threat) {
    try {
      await new Promise((resolve, reject) => {
        db.db.run(
          `INSERT INTO threat_reports 
           (guild_id, user_id, type, severity, metadata, timestamp)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            threat.guildId,
            threat.userId,
            threat.type,
            threat.severity,
            JSON.stringify(threat.metadata || {}),
            threat.timestamp || Date.now(),
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (error) {
      logger.error("ThreatCorrelationEngine", "Error storing threat:", error);
    }
  }

  /**
   * Analyze correlations across all threats
   */
  async analyzeCorrelations() {
    try {
      const correlations = [];

      // Analyze user-based correlations
      const userCorrelations = await this.analyzeUserCorrelations();
      correlations.push(...userCorrelations);

      // Analyze pattern-based correlations
      const patternCorrelations = await this.analyzePatternCorrelations();
      correlations.push(...patternCorrelations);

      // Analyze time-based correlations
      const timeCorrelations = await this.analyzeTimeCorrelations();
      correlations.push(...timeCorrelations);

      // Store significant correlations
      for (const correlation of correlations) {
        if (correlation.confidence >= 0.7) {
          await this.storeCorrelation(correlation);
          await this.notifyAffectedServers(correlation);
        }
      }

      if (correlations.length > 0) {
        logger.info(
          "ThreatCorrelationEngine",
          `Analyzed ${correlations.length} threat correlations`
        );
      }
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error analyzing correlations:",
        error
      );
    }
  }

  /**
   * Analyze user-based correlations (same user, multiple servers)
   */
  async analyzeUserCorrelations() {
    const correlations = [];
    const since = Date.now() - this.timeWindow;

    try {
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT user_id, type, COUNT(DISTINCT guild_id) as server_count,
           GROUP_CONCAT(DISTINCT guild_id) as guilds,
           AVG(severity) as avg_severity
           FROM threat_reports
           WHERE timestamp > ?
           GROUP BY user_id, type
           HAVING server_count >= ?`,
          [since, this.alertThreshold],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      for (const row of rows) {
        correlations.push({
          type: "user_multi_server",
          userId: row.user_id,
          threatType: row.type,
          affectedServers: row.guilds.split(","),
          serverCount: row.server_count,
          avgSeverity: row.avg_severity,
          confidence: Math.min(1, row.server_count / 10), // More servers = higher confidence
          detectedAt: Date.now(),
        });
      }
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error analyzing user correlations:",
        error
      );
    }

    return correlations;
  }

  /**
   * Analyze pattern-based correlations (similar behavior, different users)
   */
  async analyzePatternCorrelations() {
    const correlations = [];
    const since = Date.now() - this.timeWindow;

    try {
      // Find clusters of similar threats
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT type, metadata, COUNT(*) as count,
           COUNT(DISTINCT guild_id) as server_count,
           GROUP_CONCAT(DISTINCT guild_id) as guilds,
           GROUP_CONCAT(DISTINCT user_id) as users
           FROM threat_reports
           WHERE timestamp > ?
           GROUP BY type, metadata
           HAVING server_count >= ?`,
          [since, this.alertThreshold],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      for (const row of rows) {
        const users = row.users.split(",");
        if (users.length >= 3) {
          // At least 3 different users with same pattern
          correlations.push({
            type: "pattern_coordinated",
            threatType: row.type,
            pattern: row.metadata,
            affectedServers: row.guilds.split(","),
            serverCount: row.server_count,
            userCount: users.length,
            confidence: Math.min(1, (row.server_count * users.length) / 50),
            detectedAt: Date.now(),
          });
        }
      }
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error analyzing pattern correlations:",
        error
      );
    }

    return correlations;
  }

  /**
   * Analyze time-based correlations (synchronized attacks)
   */
  async analyzeTimeCorrelations() {
    const correlations = [];
    const since = Date.now() - 60000; // Last minute

    try {
      // Find burst of threats in short time window
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT type, COUNT(*) as count,
           COUNT(DISTINCT guild_id) as server_count,
           COUNT(DISTINCT user_id) as user_count,
           GROUP_CONCAT(DISTINCT guild_id) as guilds
           FROM threat_reports
           WHERE timestamp > ?
           GROUP BY type
           HAVING count >= 10 AND server_count >= 3`,
          [since],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      for (const row of rows) {
        correlations.push({
          type: "time_synchronized",
          threatType: row.type,
          affectedServers: row.guilds.split(","),
          serverCount: row.server_count,
          userCount: row.user_count,
          eventCount: row.count,
          confidence: Math.min(1, row.count / 50),
          detectedAt: Date.now(),
        });
      }
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error analyzing time correlations:",
        error
      );
    }

    return correlations;
  }

  /**
   * Store correlation in database
   */
  async storeCorrelation(correlation) {
    try {
      await new Promise((resolve, reject) => {
        db.db.run(
          `INSERT INTO threat_correlations 
           (type, threat_type, affected_servers, metadata, confidence, detected_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            correlation.type,
            correlation.threatType,
            JSON.stringify(correlation.affectedServers),
            JSON.stringify(correlation),
            correlation.confidence,
            correlation.detectedAt,
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error storing correlation:",
        error
      );
    }
  }

  /**
   * Notify affected servers about correlation
   */
  async notifyAffectedServers(correlation) {
    try {
      for (const guildId of correlation.affectedServers) {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) continue;

        const config = await db.getServerConfig(guildId);
        if (!config || !config.alert_channel) continue;

        const alertChannel = guild.channels.cache.get(config.alert_channel);
        if (!alertChannel) continue;

        const embed = this.buildCorrelationAlert(correlation);
        await alertChannel.send({ embeds: [embed] }).catch(() => {});
      }

      logger.info(
        "ThreatCorrelationEngine",
        `Notified ${correlation.affectedServers.length} servers about ${correlation.type}`
      );
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error notifying servers:",
        error
      );
    }
  }

  /**
   * Build correlation alert embed
   */
  buildCorrelationAlert(correlation) {
    const embed = {
      color: 0xed4245, // Red
      title: "⚠️ Cross-Server Threat Detected",
      description: this.getCorrelationDescription(correlation),
      fields: [
        {
          name: "Threat Type",
          value: correlation.threatType,
          inline: true,
        },
        {
          name: "Affected Servers",
          value: correlation.serverCount.toString(),
          inline: true,
        },
        {
          name: "Confidence",
          value: `${(correlation.confidence * 100).toFixed(0)}%`,
          inline: true,
        },
      ],
      timestamp: new Date(correlation.detectedAt).toISOString(),
      footer: {
        text: "Nexus Threat Intelligence Network",
      },
    };

    if (correlation.userId) {
      embed.fields.push({
        name: "User ID",
        value: correlation.userId,
        inline: true,
      });
    }

    if (correlation.userCount) {
      embed.fields.push({
        name: "Users Involved",
        value: correlation.userCount.toString(),
        inline: true,
      });
    }

    return embed;
  }

  /**
   * Get correlation description
   */
  getCorrelationDescription(correlation) {
    switch (correlation.type) {
      case "user_multi_server":
        return `A user has been flagged for **${correlation.threatType}** across **${correlation.serverCount}** servers. This may indicate a coordinated attack or bot account.`;
      case "pattern_coordinated":
        return `**${correlation.userCount}** users are exhibiting identical **${correlation.threatType}** behavior across **${correlation.serverCount}** servers. This suggests a coordinated attack.`;
      case "time_synchronized":
        return `**${correlation.eventCount}** **${correlation.threatType}** events detected across **${correlation.serverCount}** servers in the last minute. This indicates a synchronized attack.`;
      default:
        return `A cross-server threat pattern has been detected.`;
    }
  }

  /**
   * Trigger immediate correlation alert
   */
  async triggerCorrelationAlert(cached) {
    logger.warn(
      "ThreatCorrelationEngine",
      `IMMEDIATE ALERT: User ${cached.userId} flagged for ${cached.type} across ${cached.guilds.size} servers`
    );

    // Create correlation record
    const correlation = {
      type: "user_multi_server",
      userId: cached.userId,
      threatType: cached.type,
      affectedServers: Array.from(cached.guilds),
      serverCount: cached.guilds.size,
      confidence: Math.min(1, cached.guilds.size / 10),
      detectedAt: Date.now(),
    };

    await this.storeCorrelation(correlation);
    await this.notifyAffectedServers(correlation);
  }

  /**
   * Clean old threats from cache
   */
  cleanOldThreats() {
    const cutoff = Date.now() - this.timeWindow;
    let cleaned = 0;

    for (const [key, threat] of this.threatCache.entries()) {
      if (threat.lastSeen < cutoff) {
        this.threatCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(
        "ThreatCorrelationEngine",
        `Cleaned ${cleaned} old threats from cache`
      );
    }
  }

  /**
   * Get recent correlations
   */
  async getRecentCorrelations(limit = 10) {
    try {
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT * FROM threat_correlations
           ORDER BY detected_at DESC
           LIMIT ?`,
          [limit],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      return rows.map((row) => ({
        type: row.type,
        threatType: row.threat_type,
        affectedServers: JSON.parse(row.affected_servers),
        metadata: JSON.parse(row.metadata),
        confidence: row.confidence,
        detectedAt: row.detected_at,
      }));
    } catch (error) {
      logger.error(
        "ThreatCorrelationEngine",
        "Error getting correlations:",
        error
      );
      return [];
    }
  }

  /**
   * Get correlation statistics
   */
  async getStats() {
    try {
      const stats = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT 
            COUNT(*) as total_correlations,
            SUM(CASE WHEN type = 'user_multi_server' THEN 1 ELSE 0 END) as user_based,
            SUM(CASE WHEN type = 'pattern_coordinated' THEN 1 ELSE 0 END) as pattern_based,
            SUM(CASE WHEN type = 'time_synchronized' THEN 1 ELSE 0 END) as time_based,
            AVG(confidence) as avg_confidence
           FROM threat_correlations
           WHERE detected_at > ?`,
          [Date.now() - 86400000], // Last 24 hours
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      return {
        totalCorrelations: stats?.total_correlations || 0,
        userBased: stats?.user_based || 0,
        patternBased: stats?.pattern_based || 0,
        timeBased: stats?.time_based || 0,
        avgConfidence: stats?.avg_confidence || 0,
        cacheSize: this.threatCache.size,
      };
    } catch (error) {
      logger.error("ThreatCorrelationEngine", "Error getting stats:", error);
      return {
        totalCorrelations: 0,
        userBased: 0,
        patternBased: 0,
        timeBased: 0,
        avgConfidence: 0,
        cacheSize: 0,
      };
    }
  }
}

module.exports = ThreatCorrelationEngine;
