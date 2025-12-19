const logger = require("./logger");
const db = require("./database");
const fs = require("fs");
const path = require("path");

// Try to load TensorFlow.js with error handling
let tf = null;
let tfLoadError = null;

try {
  tf = require("@tensorflow/tfjs-node");
  logger.info("MLRaidDetection", "TensorFlow.js loaded successfully");
} catch (error) {
  tfLoadError = error.message;
  logger.warn(
    "MLRaidDetection",
    `TensorFlow.js failed to load: ${error.message}. ML features will be disabled.`
  );
}

/**
 * ML-Based Raid Pattern Recognition
 * Uses TensorFlow.js to learn and predict raid patterns
 * Falls back to rule-based detection if TensorFlow is unavailable
 */
class MLRaidDetection {
  constructor(client) {
    this.client = client;
    this.model = null;
    this.modelPath = path.join(__dirname, "../data/raid_model");
    this.isTraining = false;
    this.lastTrainingTime = 0;
    this.trainingInterval = 24 * 60 * 60 * 1000; // Retrain every 24 hours
    this.tfAvailable = tf !== null;
    this.tfLoadError = tfLoadError;

    // Feature normalization parameters (learned from training data)
    this.normalizationParams = {
      joinRate: { mean: 5, std: 10 },
      accountAge: { mean: 30, std: 60 }, // days
      membershipAge: { mean: 1, std: 5 }, // hours
      avatarSimilarity: { mean: 0.5, std: 0.3 },
      namePattern: { mean: 0.3, std: 0.2 },
      timeWindow: { mean: 10, std: 5 }, // seconds
    };

    // Initialize model
    this.initialize();
  }

  /**
   * Initialize ML model (load or create new)
   */
  async initialize() {
    // Check if TensorFlow is available
    if (!this.tfAvailable) {
      logger.warn(
        "MLRaidDetection",
        "TensorFlow not available. Using rule-based detection fallback."
      );
      return;
    }

    try {
      // Try to load existing model
      if (fs.existsSync(this.modelPath + "/model.json")) {
        logger.info("MLRaidDetection", "Loading existing model...");
        this.model = await tf.loadLayersModel(
          `file://${this.modelPath}/model.json`
        );
        logger.info("MLRaidDetection", "✅ Model loaded successfully");
      } else {
        logger.info("MLRaidDetection", "Creating new model...");
        this.model = this.createModel();
        logger.info("MLRaidDetection", "✅ New model created");
      }

      // Schedule automatic retraining
      this.scheduleRetraining();
    } catch (error) {
      logger.error("MLRaidDetection", `Failed to initialize: ${error.message}`);
      // Mark TensorFlow as unavailable
      this.tfAvailable = false;
      logger.warn(
        "MLRaidDetection",
        "ML features disabled. Using rule-based detection."
      );
    }
  }

  /**
   * Create neural network model architecture
   */
  createModel() {
    const model = tf.sequential({
      layers: [
        // Input layer (6 features)
        tf.layers.dense({
          inputShape: [6],
          units: 16,
          activation: "relu",
          name: "input_layer",
        }),

        // Hidden layer 1 - Pattern detection
        tf.layers.dense({
          units: 24,
          activation: "relu",
          name: "pattern_layer",
        }),

        // Dropout for regularization
        tf.layers.dropout({ rate: 0.2 }),

        // Hidden layer 2 - Feature combination
        tf.layers.dense({
          units: 12,
          activation: "relu",
          name: "combination_layer",
        }),

        // Output layer - Binary classification (raid or not)
        tf.layers.dense({
          units: 1,
          activation: "sigmoid",
          name: "output_layer",
        }),
      ],
    });

    // Compile model
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: "binaryCrossentropy",
      metrics: ["accuracy"],
    });

    logger.info("MLRaidDetection", "Neural network architecture created");
    return model;
  }

  /**
   * Extract features from join event
   */
  extractFeatures(member, recentJoins, timeWindow = 10000) {
    const now = Date.now();

    // Feature 1: Join rate (joins per second)
    const joinsInWindow = recentJoins.filter(
      (j) => now - j.timestamp < timeWindow
    ).length;
    const joinRate = joinsInWindow / (timeWindow / 1000);

    // Feature 2: Account age (days since creation)
    const accountAge =
      (now - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);

    // Feature 3: Membership age (hours since join)
    const membershipAge = (now - member.joinedTimestamp) / (1000 * 60 * 60);

    // Feature 4: Avatar similarity score (0-1)
    // Check if member has default avatar or similar to recent joins
    const hasDefaultAvatar = !member.user.avatar;
    const recentAvatars = recentJoins
      .map((j) => j.user?.avatar)
      .filter((a) => a);
    const sameAvatar = recentAvatars.filter(
      (a) => a === member.user.avatar
    ).length;
    const avatarSimilarity = hasDefaultAvatar
      ? 0.8
      : sameAvatar / Math.max(recentAvatars.length, 1);

    // Feature 5: Name pattern score (0-1)
    // Detect random/generated names, number patterns, etc.
    const namePatternScore = this.calculateNamePatternScore(
      member.user.username
    );

    // Feature 6: Time window (normalized)
    const timeWindowSeconds = timeWindow / 1000;

    return {
      joinRate,
      accountAge,
      membershipAge,
      avatarSimilarity,
      namePattern: namePatternScore,
      timeWindow: timeWindowSeconds,
    };
  }

  /**
   * Calculate name pattern suspiciousness score
   */
  calculateNamePatternScore(username) {
    let score = 0;

    // Check for random character patterns
    const hasRandomPattern = /[a-z]{10,}|[0-9]{5,}/.test(
      username.toLowerCase()
    );
    if (hasRandomPattern) score += 0.3;

    // Check for common bot patterns
    const botPatterns = [
      /user[0-9]+/i,
      /bot[0-9]+/i,
      /account[0-9]+/i,
      /^[a-z]{1,3}[0-9]{4,}$/i,
    ];
    if (botPatterns.some((p) => p.test(username))) score += 0.4;

    // Check for no vowels (random generated)
    const hasVowels = /[aeiou]/i.test(username);
    if (!hasVowels && username.length > 5) score += 0.2;

    // Check for repeated characters
    const hasRepeats = /(.)\1{3,}/.test(username);
    if (hasRepeats) score += 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Normalize features for model input
   */
  normalizeFeatures(features) {
    return {
      joinRate:
        (features.joinRate - this.normalizationParams.joinRate.mean) /
        this.normalizationParams.joinRate.std,
      accountAge:
        (features.accountAge - this.normalizationParams.accountAge.mean) /
        this.normalizationParams.accountAge.std,
      membershipAge:
        (features.membershipAge - this.normalizationParams.membershipAge.mean) /
        this.normalizationParams.membershipAge.std,
      avatarSimilarity:
        (features.avatarSimilarity -
          this.normalizationParams.avatarSimilarity.mean) /
        this.normalizationParams.avatarSimilarity.std,
      namePattern:
        (features.namePattern - this.normalizationParams.namePattern.mean) /
        this.normalizationParams.namePattern.std,
      timeWindow:
        (features.timeWindow - this.normalizationParams.timeWindow.mean) /
        this.normalizationParams.timeWindow.std,
    };
  }

  /**
   * Predict if current pattern is a raid
   */
  async predict(member, recentJoins, timeWindow = 10000) {
    // Fall back to rule-based detection if TensorFlow unavailable
    if (!this.tfAvailable || !this.model) {
      return this.ruleBasedPredict(member, recentJoins, timeWindow);
    }

    try {
      // Extract features
      const features = this.extractFeatures(member, recentJoins, timeWindow);
      const normalized = this.normalizeFeatures(features);

      // Convert to tensor
      const inputTensor = tf.tensor2d([
        [
          normalized.joinRate,
          normalized.accountAge,
          normalized.membershipAge,
          normalized.avatarSimilarity,
          normalized.namePattern,
          normalized.timeWindow,
        ],
      ]);

      // Predict
      const prediction = await this.model.predict(inputTensor);
      const confidence = (await prediction.data())[0];

      // Cleanup tensors
      inputTensor.dispose();
      prediction.dispose();

      // Threshold: 0.7+ confidence = raid
      const isRaid = confidence >= 0.7;

      logger.debug(
        "MLRaidDetection",
        `Prediction: ${isRaid ? "RAID" : "Safe"} (confidence: ${(confidence * 100).toFixed(1)}%)`
      );

      return {
        isRaid,
        confidence,
        features,
        normalized,
      };
    } catch (error) {
      logger.error("MLRaidDetection", `Prediction failed: ${error.message}`);
      return { isRaid: false, confidence: 0, features: {} };
    }
  }

  /**
   * Rule-based prediction fallback (when TensorFlow unavailable)
   */
  ruleBasedPredict(member, recentJoins, timeWindow = 10000) {
    try {
      // Extract features
      const features = this.extractFeatures(member, recentJoins, timeWindow);

      // Calculate threat score using rules
      let threatScore = 0;

      // Rule 1: High join rate (> 5 per second = suspicious)
      if (features.joinRate > 5) {
        threatScore += 0.3;
      }

      // Rule 2: New account (< 7 days = suspicious)
      if (features.accountAge < 7) {
        threatScore += 0.25;
      }

      // Rule 3: Just joined (< 1 hour = suspicious)
      if (features.membershipAge < 1) {
        threatScore += 0.15;
      }

      // Rule 4: High avatar similarity
      if (features.avatarSimilarity > 0.7) {
        threatScore += 0.2;
      }

      // Rule 5: Suspicious name pattern
      if (features.namePattern > 0.5) {
        threatScore += 0.1;
      }

      const isRaid = threatScore >= 0.7;

      logger.debug(
        "MLRaidDetection",
        `Rule-based prediction: ${isRaid ? "RAID" : "Safe"} (score: ${(threatScore * 100).toFixed(1)}%)`
      );

      return {
        isRaid,
        confidence: threatScore,
        features,
        method: "rule-based",
      };
    } catch (error) {
      logger.error(
        "MLRaidDetection",
        `Rule-based prediction failed: ${error.message}`
      );
      return { isRaid: false, confidence: 0, features: {}, method: "error" };
    }
  }

  /**
   * Train model on historical raid data
   */
  async train() {
    // Skip if TensorFlow unavailable
    if (!this.tfAvailable) {
      logger.warn(
        "MLRaidDetection",
        "TensorFlow unavailable. Cannot train model."
      );
      return;
    }

    if (this.isTraining) {
      logger.warn("MLRaidDetection", "Training already in progress");
      return;
    }

    this.isTraining = true;
    logger.info("MLRaidDetection", "Starting model training...");

    try {
      // Fetch training data from database
      const trainingData = await this.getTrainingData();

      if (trainingData.length < 10) {
        logger.warn(
          "MLRaidDetection",
          `Insufficient training data (${trainingData.length} samples), skipping training`
        );
        this.isTraining = false;
        return;
      }

      logger.info(
        "MLRaidDetection",
        `Training on ${trainingData.length} historical events`
      );

      // Prepare training tensors
      const xs = tf.tensor2d(
        trainingData.map((d) => [
          d.features.joinRate,
          d.features.accountAge,
          d.features.membershipAge,
          d.features.avatarSimilarity,
          d.features.namePattern,
          d.features.timeWindow,
        ])
      );

      const ys = tf.tensor2d(trainingData.map((d) => [d.isRaid ? 1 : 0]));

      // Train model
      const history = await this.model.fit(xs, ys, {
        epochs: 50,
        batchSize: 32,
        validationSplit: 0.2,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            if (epoch % 10 === 0) {
              logger.debug(
                "MLRaidDetection",
                `Epoch ${epoch}: loss=${logs.loss.toFixed(4)}, acc=${(logs.acc * 100).toFixed(1)}%`
              );
            }
          },
        },
      });

      // Cleanup tensors
      xs.dispose();
      ys.dispose();

      // Save model
      await this.saveModel();

      const finalLoss = history.history.loss[history.history.loss.length - 1];
      const finalAcc = history.history.acc[history.history.acc.length - 1];

      logger.info(
        "MLRaidDetection",
        `✅ Training complete: loss=${finalLoss.toFixed(4)}, accuracy=${(finalAcc * 100).toFixed(1)}%`
      );

      this.lastTrainingTime = Date.now();
    } catch (error) {
      logger.error("MLRaidDetection", `Training failed: ${error.message}`);
    } finally {
      this.isTraining = false;
    }
  }

  /**
   * Get training data from database
   */
  async getTrainingData() {
    // Fetch historical raid events
    const raidEvents = await this.getRaidEventsFromDB();

    // Fetch normal (non-raid) join events
    const normalEvents = await this.getNormalJoinsFromDB();

    // Combine and label
    const labeled = [
      ...raidEvents.map((e) => ({ ...e, isRaid: true })),
      ...normalEvents.map((e) => ({ ...e, isRaid: false })),
    ];

    // Shuffle
    return labeled.sort(() => Math.random() - 0.5);
  }

  /**
   * Fetch raid events from security logs
   */
  async getRaidEventsFromDB() {
    return new Promise((resolve) => {
      db.db.all(
        `SELECT * FROM security_logs 
         WHERE threat_type = 'raid' 
         AND action_taken LIKE '%banned%'
         ORDER BY timestamp DESC 
         LIMIT 500`,
        [],
        (err, rows) => {
          if (err || !rows) {
            resolve([]);
          } else {
            // Convert to feature format (simplified - in production, store actual features)
            const events = rows.map((row) => ({
              features: {
                joinRate: row.threat_score / 10 || 3,
                accountAge: 5, // Estimate
                membershipAge: 0.1, // Very recent
                avatarSimilarity: 0.7, // High similarity in raids
                namePattern: 0.6, // Suspicious names
                timeWindow: 10,
              },
            }));
            resolve(events);
          }
        }
      );
    });
  }

  /**
   * Fetch normal join events (non-raids)
   */
  async getNormalJoinsFromDB() {
    // Generate synthetic normal join patterns
    // In production, store actual join features
    const normalPatterns = [];
    for (let i = 0; i < 300; i++) {
      normalPatterns.push({
        features: {
          joinRate: Math.random() * 2, // Low join rate
          accountAge: Math.random() * 100 + 10, // Older accounts
          membershipAge: Math.random() * 48, // Various membership ages
          avatarSimilarity: Math.random() * 0.3, // Low similarity
          namePattern: Math.random() * 0.3, // Normal names
          timeWindow: 10,
        },
      });
    }
    return normalPatterns;
  }

  /**
   * Save model to disk
   */
  async saveModel() {
    try {
      // Create directory if it doesn't exist
      const dir = path.dirname(this.modelPath + "/model.json");
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      await this.model.save(`file://${this.modelPath}`);
      logger.info("MLRaidDetection", "✅ Model saved successfully");
    } catch (error) {
      logger.error("MLRaidDetection", `Failed to save model: ${error.message}`);
    }
  }

  /**
   * Schedule automatic retraining
   */
  scheduleRetraining() {
    setInterval(
      async () => {
        const timeSinceLastTraining = Date.now() - this.lastTrainingTime;
        if (timeSinceLastTraining >= this.trainingInterval) {
          logger.info("MLRaidDetection", "Scheduled retraining triggered");
          await this.train();
        }
      },
      60 * 60 * 1000
    ); // Check every hour

    logger.info(
      "MLRaidDetection",
      "Automatic retraining scheduled (every 24 hours)"
    );
  }

  /**
   * Get model statistics
   */
  getStats() {
    return {
      tfAvailable: this.tfAvailable,
      tfLoadError: this.tfLoadError,
      modelLoaded: this.model !== null,
      isTraining: this.isTraining,
      lastTrainingTime: this.lastTrainingTime,
      nextTrainingIn: Math.max(
        0,
        this.trainingInterval - (Date.now() - this.lastTrainingTime)
      ),
      detectionMethod: this.tfAvailable && this.model ? "ml" : "rule-based",
    };
  }
}

module.exports = MLRaidDetection;
