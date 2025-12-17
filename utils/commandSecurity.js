/**
 * Command Security Utilities
 * Reusable security checks for all commands to prevent vulnerabilities
 */

const { PermissionFlagsBits, MessageFlags } = require("discord.js");
const ErrorMessages = require("./errorMessages");

class CommandSecurity {
  /**
   * Check if bot has required permission
   * @param {GuildMember} botMember - Bot's guild member
   * @param {string|bigint} permission - Permission to check
   * @returns {Object|null} Error response if missing, null if OK
   */
  static checkBotPermission(botMember, permission) {
    if (!botMember.permissions.has(permission)) {
      return ErrorMessages.botNoPermission(
        typeof permission === "string" ? permission : PermissionFlagsBits[permission]
      );
    }
    return null;
  }

  /**
   * Check if executor can target the member (role hierarchy check)
   * @param {GuildMember} executor - User executing the command
   * @param {GuildMember} target - Target member
   * @param {Guild} guild - The guild
   * @returns {Object|null} Error response if cannot target, null if OK
   */
  static checkCanTarget(executor, target, guild) {
    const isOwner = guild.ownerId === executor.id;
    
    // Owners can always target anyone
    if (isOwner) return null;
    
    // Check role hierarchy
    if (target.roles.highest.position >= executor.roles.highest.position) {
      return {
        content: "❌ You cannot target users with equal or higher roles!",
        flags: MessageFlags.Ephemeral,
      };
    }
    
    return null;
  }

  /**
   * Check if bot can manage a role
   * @param {Role} role - Role to check
   * @param {GuildMember} botMember - Bot's guild member
   * @param {Guild} guild - The guild
   * @returns {boolean} True if bot can manage the role
   */
  static canBotManageRole(role, botMember, guild) {
    // Can't manage @everyone
    if (role.id === guild.id) return false;
    
    // Can't manage roles managed by integrations
    if (role.managed) return false;
    
    // Can't manage roles higher than bot's highest role
    const botHighestRole = botMember.roles.highest;
    if (role.position >= botHighestRole.position) return false;
    
    return true;
  }

  /**
   * Filter roles to only those the bot can manage
   * @param {Array<string>} roleIds - Array of role IDs
   * @param {Guild} guild - The guild
   * @param {GuildMember} botMember - Bot's guild member
   * @returns {Array<Role>} Array of manageable roles
   */
  static filterManageableRoles(roleIds, guild, botMember) {
    return roleIds
      .map((id) => guild.roles.cache.get(id))
      .filter((role) => role && this.canBotManageRole(role, botMember, guild));
  }

  /**
   * Sanitize string input to prevent XSS
   * @param {string} input - Input string
   * @param {number} maxLength - Maximum length (default: 1000)
   * @returns {string} Sanitized string
   */
  static sanitizeInput(input, maxLength = 1000) {
    if (!input || typeof input !== "string") return "";
    
    return input
      .trim()
      .replace(/[<>]/g, "") // Remove angle brackets
      .replace(/\0/g, "") // Remove null bytes
      .replace(/[\x00-\x1F\x7F-\x9F]/g, "") // Remove control characters
      .substring(0, maxLength);
  }

  /**
   * Validate string input
   * @param {string} input - Input to validate
   * @param {string} fieldName - Name of the field (for error messages)
   * @param {number} minLength - Minimum length (default: 1)
   * @param {number} maxLength - Maximum length (default: 100)
   * @returns {Object|null} Error response if invalid, null if OK
   */
  static validateInput(input, fieldName = "Input", minLength = 1, maxLength = 100) {
    if (!input || typeof input !== "string") {
      return {
        content: `❌ ${fieldName} cannot be empty!`,
        flags: MessageFlags.Ephemeral,
      };
    }

    const trimmed = input.trim();
    
    if (trimmed.length < minLength) {
      return {
        content: `❌ ${fieldName} must be at least ${minLength} character(s)!`,
        flags: MessageFlags.Ephemeral,
      };
    }

    if (trimmed.length > maxLength) {
      return {
        content: `❌ ${fieldName} must be ${maxLength} characters or less!`,
        flags: MessageFlags.Ephemeral,
      };
    }

    return null;
  }

  /**
   * Comprehensive security check for role management commands
   * @param {Interaction} interaction - Discord interaction
   * @param {string|bigint} requiredPermission - Required bot permission
   * @param {GuildMember} targetMember - Target member (optional)
   * @returns {Object|null} Error response if check fails, null if OK
   */
  static async checkRoleManagementSecurity(interaction, requiredPermission, targetMember = null) {
    // Check bot permissions
    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);
    const botPermCheck = this.checkBotPermission(botMember, requiredPermission);
    if (botPermCheck) return botPermCheck;

    // Check if targeting a member
    if (targetMember) {
      const targetCheck = this.checkCanTarget(interaction.member, targetMember, interaction.guild);
      if (targetCheck) return targetCheck;
    }

    return null;
  }

  /**
   * Validate and sanitize role IDs from input
   * @param {string} rolesInput - Input string with role IDs/mentions
   * @param {Guild} guild - The guild
   * @param {GuildMember} botMember - Bot's guild member
   * @returns {Object} { valid: boolean, roles: Array<Role>, error: Object|null }
   */
  static parseAndValidateRoles(rolesInput, guild, botMember) {
    // Parse role IDs from mentions or raw IDs
    const roleIds = rolesInput
      .split(/\s+/)
      .map((r) => {
        const match = r.match(/<@&(\d+)>|(\d+)/);
        return match ? match[1] || match[2] : null;
      })
      .filter((id) => id && guild.roles.cache.has(id));

    if (roleIds.length === 0) {
      return {
        valid: false,
        roles: [],
        error: {
          content: "❌ No valid roles found!",
          flags: MessageFlags.Ephemeral,
        },
      };
    }

    // Filter to only manageable roles
    const manageableRoles = this.filterManageableRoles(roleIds, guild, botMember);

    if (manageableRoles.length === 0) {
      return {
        valid: false,
        roles: [],
        error: {
          content: "❌ I cannot manage any of the provided roles! Make sure:\n- Roles are below my highest role\n- Roles are not managed by integrations\n- Roles are not @everyone",
          flags: MessageFlags.Ephemeral,
        },
      };
    }

    return {
      valid: true,
      roles: manageableRoles,
      roleIds: manageableRoles.map((r) => r.id),
      error: null,
      warning: manageableRoles.length < roleIds.length
        ? `⚠️ Some roles were excluded because I cannot manage them. Only ${manageableRoles.length} of ${roleIds.length} roles will be used.`
        : null,
    };
  }
}

module.exports = CommandSecurity;

