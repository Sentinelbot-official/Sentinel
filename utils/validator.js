// Input validation utilities
// DEPRECATED: This file is kept for backward compatibility
// Please use utils/inputValidator.js instead
// This file will be removed in a future version

const InputValidator = require("./inputValidator");

/**
 * @deprecated Use InputValidator instead
 */
class Validator {
  static validateGuildId(guildId) {
    return InputValidator.validateGuildId(guildId);
  }

  static validateUserId(userId) {
    return InputValidator.validateUserId(userId);
  }

  static validateChannelId(channelId) {
    return InputValidator.validateChannelId(channelId);
  }

  static validateReason(reason, maxLength = 512) {
    return InputValidator.validateReason(reason, maxLength);
  }

  static validateTime(timeString) {
    return InputValidator.validateTime(timeString);
  }

  static sanitizeInput(input) {
    return InputValidator.sanitizeInput(input);
  }
}

module.exports = Validator;

