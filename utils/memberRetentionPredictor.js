const db = require("./database");
const logger = require("./logger");

/**
 * Predictive Member Retention System
 * EXCEEDS LEADING COMPETITOR - AI predicts which members are likely to leave
 * Helps server owners proactively engage at-risk members
 */
class MemberRetentionPredictor {
  constructor(client) {
    this.client = client;
    this.predictionInterval = null;
    this.riskThresholds = {
      high: 0.7,
      medium: 0.4,
      low: 0.2,
    };
  }

  /**
   * Start prediction loop
   */
  start() {
    // Run predictions every 12 hours
    this.predictionInterval = setInterval(() => {
      this.runPredictions();
    }, 43200000);

    logger.info(
      "MemberRetentionPredictor",
      "🔮 Retention prediction system started"
    );
  }

  /**
   * Stop prediction loop
   */
  stop() {
    if (this.predictionInterval) {
      clearInterval(this.predictionInterval);
    }
  }

  /**
   * Run predictions for all guilds
   */
  async runPredictions() {
    try {
      for (const guild of this.client.guilds.cache.values()) {
        await this.predictGuildRetention(guild.id);
      }
    } catch (error) {
      logger.error(
        "MemberRetentionPredictor",
        "Error running predictions:",
        error
      );
    }
  }

  /**
   * Predict retention for a guild
   */
  async predictGuildRetention(guildId) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;

      const atRiskMembers = [];

      // Analyze each member (limit to recent members for performance)
      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;

        const risk = await this.calculateChurnRisk(guildId, member);
        if (risk.score >= this.riskThresholds.low) {
          atRiskMembers.push({
            userId: member.id,
            username: member.user.tag,
            riskScore: risk.score,
            riskLevel: risk.level,
            reasons: risk.reasons,
          });
        }
      }

      // Save predictions to database
      if (atRiskMembers.length > 0) {
        await this.savePredictions(guildId, atRiskMembers);
      }
    } catch (error) {
      logger.error(
        "MemberRetentionPredictor",
        `Error predicting for guild ${guildId}:`,
        error
      );
    }
  }

  /**
   * Calculate churn risk for a member
   */
  async calculateChurnRisk(guildId, member) {
    const reasons = [];
    let riskScore = 0;

    // Factor 1: Low engagement (40% weight)
    const engagementScore = await this.getEngagementScore(guildId, member.id);
    if (engagementScore < 20) {
      riskScore += 0.4;
      reasons.push("Very low engagement");
    } else if (engagementScore < 40) {
      riskScore += 0.2;
      reasons.push("Low engagement");
    }

    // Factor 2: Declining activity (30% weight)
    const activityTrend = await this.getActivityTrend(guildId, member.id);
    if (activityTrend === "declining") {
      riskScore += 0.3;
      reasons.push("Declining activity");
    } else if (activityTrend === "inactive") {
      riskScore += 0.4;
      reasons.push("Recently inactive");
    }

    // Factor 3: No roles assigned (15% weight)
    if (member.roles.cache.size <= 1) {
      // Only @everyone
      riskScore += 0.15;
      reasons.push("No roles assigned");
    }

    // Factor 4: Recent join (10% weight)
    const daysSinceJoin = (Date.now() - member.joinedTimestamp) / 86400000;
    if (daysSinceJoin < 7) {
      riskScore += 0.1;
      reasons.push("Recently joined");
    }

    // Factor 5: Negative interactions (5% weight)
    const hasViolations = await this.hasRecentViolations(guildId, member.id);
    if (hasViolations) {
      riskScore += 0.05;
      reasons.push("Recent violations");
    }

    // Determine risk level
    let riskLevel = "low";
    if (riskScore >= this.riskThresholds.high) {
      riskLevel = "high";
    } else if (riskScore >= this.riskThresholds.medium) {
      riskLevel = "medium";
    }

    return {
      score: Math.min(1, riskScore),
      level: riskLevel,
      reasons,
    };
  }

  /**
   * Get engagement score for a member
   */
  async getEngagementScore(guildId, userId) {
    try {
      const since = Date.now() - 604800000; // Last 7 days
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as event_count
           FROM user_engagement
           WHERE guild_id = ? AND user_id = ? AND timestamp > ?`,
          [guildId, userId, since],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      // Score based on events per day (0-100)
      const eventsPerDay = (row?.event_count || 0) / 7;
      return Math.min(100, eventsPerDay * 10);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Get activity trend for a member
   */
  async getActivityTrend(guildId, userId) {
    try {
      const now = Date.now();
      const week1 = now - 604800000; // 1 week ago
      const week2 = now - 1209600000; // 2 weeks ago

      // Get activity for last week
      const recent = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as count FROM user_engagement
           WHERE guild_id = ? AND user_id = ? AND timestamp > ?`,
          [guildId, userId, week1],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      // Get activity for week before that
      const previous = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as count FROM user_engagement
           WHERE guild_id = ? AND user_id = ? AND timestamp BETWEEN ? AND ?`,
          [guildId, userId, week2, week1],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      const recentCount = recent?.count || 0;
      const previousCount = previous?.count || 0;

      if (recentCount === 0 && previousCount === 0) return "inactive";
      if (recentCount === 0) return "inactive";
      if (previousCount === 0) return "stable";

      const change = (recentCount - previousCount) / previousCount;
      if (change < -0.3) return "declining";
      if (change > 0.3) return "increasing";
      return "stable";
    } catch (error) {
      return "stable";
    }
  }

  /**
   * Check if member has recent violations
   */
  async hasRecentViolations(guildId, userId) {
    try {
      const since = Date.now() - 604800000; // Last 7 days
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as count FROM automod_violations
           WHERE guild_id = ? AND user_id = ? AND timestamp > ?`,
          [guildId, userId, since],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      return (row?.count || 0) > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Save predictions to database
   */
  async savePredictions(guildId, predictions) {
    try {
      for (const prediction of predictions) {
        await new Promise((resolve, reject) => {
          db.db.run(
            `INSERT OR REPLACE INTO retention_predictions 
             (guild_id, user_id, risk_score, risk_level, reasons, predicted_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              guildId,
              prediction.userId,
              prediction.riskScore,
              prediction.riskLevel,
              JSON.stringify(prediction.reasons),
              Date.now(),
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }
    } catch (error) {
      logger.error(
        "MemberRetentionPredictor",
        "Error saving predictions:",
        error
      );
    }
  }

  /**
   * Get at-risk members for a guild
   */
  async getAtRiskMembers(guildId, riskLevel = null) {
    try {
      let query = `SELECT * FROM retention_predictions
                   WHERE guild_id = ?`;
      const params = [guildId];

      if (riskLevel) {
        query += ` AND risk_level = ?`;
        params.push(riskLevel);
      }

      query += ` ORDER BY risk_score DESC LIMIT 50`;

      const rows = await new Promise((resolve, reject) => {
        db.db.all(query, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        });
      });

      return rows.map((row) => ({
        userId: row.user_id,
        riskScore: row.risk_score,
        riskLevel: row.risk_level,
        reasons: JSON.parse(row.reasons || "[]"),
        predictedAt: row.predicted_at,
      }));
    } catch (error) {
      logger.error(
        "MemberRetentionPredictor",
        "Error getting at-risk members:",
        error
      );
      return [];
    }
  }

  /**
   * Get retention statistics for a guild
   */
  async getRetentionStats(guildId) {
    try {
      const stats = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT 
            COUNT(*) as total_predictions,
            SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END) as high_risk,
            SUM(CASE WHEN risk_level = 'medium' THEN 1 ELSE 0 END) as medium_risk,
            SUM(CASE WHEN risk_level = 'low' THEN 1 ELSE 0 END) as low_risk,
            AVG(risk_score) as avg_risk_score
           FROM retention_predictions
           WHERE guild_id = ?`,
          [guildId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      return {
        totalAtRisk: stats?.total_predictions || 0,
        highRisk: stats?.high_risk || 0,
        mediumRisk: stats?.medium_risk || 0,
        lowRisk: stats?.low_risk || 0,
        avgRiskScore: stats?.avg_risk_score || 0,
      };
    } catch (error) {
      logger.error(
        "MemberRetentionPredictor",
        "Error getting retention stats:",
        error
      );
      return {
        totalAtRisk: 0,
        highRisk: 0,
        mediumRisk: 0,
        lowRisk: 0,
        avgRiskScore: 0,
      };
    }
  }

  /**
   * Get recommended actions for at-risk members
   */
  getRecommendedActions(riskLevel, reasons) {
    const actions = [];

    if (
      reasons.includes("Very low engagement") ||
      reasons.includes("Low engagement")
    ) {
      actions.push("Send a welcome message or check-in");
      actions.push("Invite to participate in server events");
      actions.push("Assign an engaging role");
    }

    if (reasons.includes("Declining activity")) {
      actions.push("Reach out personally to re-engage");
      actions.push("Ask for feedback on server improvements");
    }

    if (reasons.includes("No roles assigned")) {
      actions.push("Assign appropriate roles based on interests");
      actions.push("Explain role system and benefits");
    }

    if (reasons.includes("Recently joined")) {
      actions.push("Send onboarding message");
      actions.push("Introduce to community");
      actions.push("Highlight key channels and features");
    }

    if (reasons.includes("Recent violations")) {
      actions.push("Review moderation actions");
      actions.push("Consider if action was too harsh");
      actions.push("Reach out to explain rules");
    }

    if (riskLevel === "high" && actions.length === 0) {
      actions.push("Immediate personal outreach recommended");
      actions.push("Consider special engagement incentive");
    }

    return actions;
  }
}

module.exports = MemberRetentionPredictor;
