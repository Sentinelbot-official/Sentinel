const db = require("./database");
const logger = require("./logger");

/**
 * Auto-Moderation ML Training Utility
 * EXCEEDS WICK - Self-learning system that improves over time
 * Learns from moderator actions to improve auto-moderation accuracy
 */
class AutomodMLTrainer {
  constructor(client) {
    this.client = client;
    this.trainingInterval = null;
    this.models = new Map(); // Guild-specific models
    this.minTrainingData = 100; // Minimum violations needed to train
  }

  /**
   * Start training loop
   */
  start() {
    // Train models every 6 hours
    this.trainingInterval = setInterval(() => {
      this.trainAllModels();
    }, 21600000);

    logger.info("AutomodMLTrainer", "🧠 ML training system started");
  }

  /**
   * Stop training loop
   */
  stop() {
    if (this.trainingInterval) {
      clearInterval(this.trainingInterval);
    }
  }

  /**
   * Train models for all guilds
   */
  async trainAllModels() {
    try {
      logger.info("AutomodMLTrainer", "Starting model training cycle...");

      for (const guild of this.client.guilds.cache.values()) {
        await this.trainModel(guild.id);
      }

      logger.info("AutomodMLTrainer", "Model training cycle completed");
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error in training cycle:", error);
    }
  }

  /**
   * Train model for a specific guild
   */
  async trainModel(guildId) {
    try {
      // Get training data (violations + moderator actions)
      const trainingData = await this.getTrainingData(guildId);

      if (trainingData.length < this.minTrainingData) {
        logger.debug(
          "AutomodMLTrainer",
          `Insufficient training data for guild ${guildId} (${trainingData.length}/${this.minTrainingData})`
        );
        return;
      }

      // Extract features and labels
      const { features, labels } = this.prepareTrainingData(trainingData);

      // Train model (simple weighted scoring for now)
      const model = this.trainWeightedModel(features, labels);

      // Store model
      this.models.set(guildId, model);

      // Save model to database
      await this.saveModel(guildId, model);

      logger.info(
        "AutomodMLTrainer",
        `Model trained for guild ${guildId} with ${trainingData.length} samples`
      );
    } catch (error) {
      logger.error(
        "AutomodMLTrainer",
        `Error training model for guild ${guildId}:`,
        error
      );
    }
  }

  /**
   * Get training data from database
   */
  async getTrainingData(guildId) {
    try {
      const rows = await new Promise((resolve, reject) => {
        db.db.all(
          `SELECT 
            av.violation_type,
            av.message_content,
            av.action_taken,
            ml.user_id,
            ml.action as mod_action,
            ml.reason as mod_reason
           FROM automod_violations av
           LEFT JOIN moderation_logs ml ON av.guild_id = ml.guild_id 
             AND av.user_id = ml.user_id
             AND ABS(av.timestamp - ml.timestamp) < 60000
           WHERE av.guild_id = ?
           ORDER BY av.timestamp DESC
           LIMIT 1000`,
          [guildId],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          }
        );
      });

      return rows;
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error getting training data:", error);
      return [];
    }
  }

  /**
   * Prepare training data (feature extraction)
   */
  prepareTrainingData(data) {
    const features = [];
    const labels = [];

    for (const sample of data) {
      // Extract features
      const feature = {
        violationType: this.encodeViolationType(sample.violation_type),
        messageLength: sample.message_content?.length || 0,
        hasLinks: /https?:\/\//.test(sample.message_content || "") ? 1 : 0,
        hasMentions: /@/.test(sample.message_content || "") ? 1 : 0,
        capsRatio: this.calculateCapsRatio(sample.message_content || ""),
        emojiCount: (sample.message_content?.match(/:\w+:/g) || []).length,
        autoAction: this.encodeAction(sample.action_taken),
      };

      // Label: 1 if moderator confirmed/escalated, 0 if overturned/ignored
      const label = this.determineLabel(sample);

      features.push(feature);
      labels.push(label);
    }

    return { features, labels };
  }

  /**
   * Encode violation type to numeric
   */
  encodeViolationType(type) {
    const types = {
      spam: 1,
      links: 2,
      caps: 3,
      emoji_spam: 4,
      mention_spam: 5,
      invites: 6,
    };
    return types[type] || 0;
  }

  /**
   * Encode action to numeric
   */
  encodeAction(action) {
    const actions = {
      delete: 1,
      warn: 2,
      timeout: 3,
      kick: 4,
      ban: 5,
    };
    return actions[action] || 0;
  }

  /**
   * Calculate caps ratio
   */
  calculateCapsRatio(text) {
    if (!text || text.length === 0) return 0;
    const caps = (text.match(/[A-Z]/g) || []).length;
    return caps / text.length;
  }

  /**
   * Determine label from moderator action
   */
  determineLabel(sample) {
    // If moderator took action within 1 minute, it's a true positive
    if (sample.mod_action) {
      // Escalated actions (timeout, kick, ban) = strong positive
      if (["timeout", "kick", "ban"].includes(sample.mod_action)) {
        return 1.0;
      }
      // Warn = moderate positive
      if (sample.mod_action === "warn") {
        return 0.7;
      }
      // Unmute/unban = false positive
      if (["unmute", "unban"].includes(sample.mod_action)) {
        return 0.0;
      }
    }

    // No moderator action = assume automod was correct (weak positive)
    return 0.5;
  }

  /**
   * Train weighted model (simple approach)
   */
  trainWeightedModel(features, labels) {
    const model = {
      weights: {
        violationType: 0,
        messageLength: 0,
        hasLinks: 0,
        hasMentions: 0,
        capsRatio: 0,
        emojiCount: 0,
        autoAction: 0,
      },
      threshold: 0.5,
      accuracy: 0,
    };

    // Calculate weights based on correlation with labels
    for (const key of Object.keys(model.weights)) {
      let correlation = 0;
      for (let i = 0; i < features.length; i++) {
        correlation += features[i][key] * labels[i];
      }
      model.weights[key] = correlation / features.length;
    }

    // Normalize weights
    const maxWeight = Math.max(...Object.values(model.weights));
    if (maxWeight > 0) {
      for (const key of Object.keys(model.weights)) {
        model.weights[key] /= maxWeight;
      }
    }

    // Calculate accuracy on training data
    let correct = 0;
    for (let i = 0; i < features.length; i++) {
      const prediction = this.predict(features[i], model);
      if (
        (prediction >= 0.5 && labels[i] >= 0.5) ||
        (prediction < 0.5 && labels[i] < 0.5)
      ) {
        correct++;
      }
    }
    model.accuracy = correct / features.length;

    return model;
  }

  /**
   * Predict using trained model
   */
  predict(features, model) {
    let score = 0;
    for (const [key, value] of Object.entries(features)) {
      score += value * (model.weights[key] || 0);
    }
    return Math.min(1, Math.max(0, score));
  }

  /**
   * Get prediction for a message
   */
  async getPrediction(guildId, message, violationType) {
    try {
      const model = this.models.get(guildId);
      if (!model) {
        // No trained model, use default
        return { confidence: 0.5, shouldAct: true };
      }

      const features = {
        violationType: this.encodeViolationType(violationType),
        messageLength: message.content?.length || 0,
        hasLinks: /https?:\/\//.test(message.content || "") ? 1 : 0,
        hasMentions: message.mentions?.users?.size > 0 ? 1 : 0,
        capsRatio: this.calculateCapsRatio(message.content || ""),
        emojiCount: (message.content?.match(/:\w+:/g) || []).length,
        autoAction: 1, // Assume delete for now
      };

      const confidence = this.predict(features, model);

      return {
        confidence,
        shouldAct: confidence >= model.threshold,
        modelAccuracy: model.accuracy,
      };
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error getting prediction:", error);
      return { confidence: 0.5, shouldAct: true };
    }
  }

  /**
   * Save model to database
   */
  async saveModel(guildId, model) {
    try {
      await new Promise((resolve, reject) => {
        db.db.run(
          `INSERT OR REPLACE INTO ml_models (guild_id, model_type, model_data, accuracy, trained_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            guildId,
            "automod",
            JSON.stringify(model),
            model.accuracy,
            Date.now(),
          ],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error saving model:", error);
    }
  }

  /**
   * Load model from database
   */
  async loadModel(guildId) {
    try {
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT model_data, accuracy FROM ml_models
           WHERE guild_id = ? AND model_type = 'automod'
           ORDER BY trained_at DESC
           LIMIT 1`,
          [guildId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      if (row) {
        const model = JSON.parse(row.model_data);
        this.models.set(guildId, model);
        logger.info(
          "AutomodMLTrainer",
          `Loaded model for guild ${guildId} (accuracy: ${(row.accuracy * 100).toFixed(1)}%)`
        );
      }
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error loading model:", error);
    }
  }

  /**
   * Load all models on startup
   */
  async loadAllModels() {
    try {
      for (const guild of this.client.guilds.cache.values()) {
        await this.loadModel(guild.id);
      }
      logger.info("AutomodMLTrainer", "All models loaded");
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error loading models:", error);
    }
  }

  /**
   * Get model stats for a guild
   */
  async getModelStats(guildId) {
    try {
      const model = this.models.get(guildId);
      if (!model) {
        return {
          trained: false,
          accuracy: 0,
          trainingDataCount: 0,
        };
      }

      // Get training data count
      const row = await new Promise((resolve, reject) => {
        db.db.get(
          `SELECT COUNT(*) as count FROM automod_violations
           WHERE guild_id = ?`,
          [guildId],
          (err, row) => {
            if (err) reject(err);
            else resolve(row);
          }
        );
      });

      return {
        trained: true,
        accuracy: model.accuracy,
        trainingDataCount: row?.count || 0,
        weights: model.weights,
      };
    } catch (error) {
      logger.error("AutomodMLTrainer", "Error getting model stats:", error);
      return { trained: false, accuracy: 0, trainingDataCount: 0 };
    }
  }
}

module.exports = AutomodMLTrainer;
