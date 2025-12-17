const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const db = require("../utils/database");
const ErrorMessages = require("../utils/errorMessages");
const CommandSecurity = require("../utils/commandSecurity");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("roletemplate")
    .setDescription("Create and manage role templates")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a role template")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Template name")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("roles")
            .setDescription("Role IDs or mentions separated by spaces")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("apply")
        .setDescription("Apply a role template to a user")
        .addStringOption((option) =>
          option
            .setName("template")
            .setDescription("Template name")
            .setRequired(true)
        )
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("User to apply template to")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("list").setDescription("List all templates")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("delete")
        .setDescription("Delete a template")
        .addStringOption((option) =>
          option
            .setName("template")
            .setDescription("Template name")
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    // Get bot member for security checks
    const botMember = await interaction.guild.members.fetch(interaction.client.user.id);

    if (subcommand === "create") {
      const name = interaction.options.getString("name");
      const rolesStr = interaction.options.getString("roles");

      // Input validation using security utility
      const nameValidation = CommandSecurity.validateInput(name, "Template name", 1, 100);
      if (nameValidation) return interaction.reply(nameValidation);

      // Sanitize template name (prevent XSS)
      const sanitizedName = CommandSecurity.sanitizeInput(name, 100);

      // Check bot permission
      const botPermCheck = CommandSecurity.checkBotPermission(botMember, PermissionFlagsBits.ManageRoles);
      if (botPermCheck) return interaction.reply(botPermCheck);

      // Parse and validate roles using security utility
      const rolesResult = CommandSecurity.parseAndValidateRoles(rolesStr, interaction.guild, botMember);
      if (!rolesResult.valid) {
        return interaction.reply(rolesResult.error);
      }

      if (rolesResult.warning) {
        await interaction.reply({
          content: rolesResult.warning,
          flags: MessageFlags.Ephemeral,
        });
      }

      const manageableRoles = rolesResult.roleIds;

      // Check if template exists
      const existing = await new Promise((resolve, reject) => {
        db.db.get(
          "SELECT * FROM role_templates WHERE guild_id = ? AND template_name = ?",
          [interaction.guild.id, sanitizedName],
          (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });

      if (existing) {
        return interaction.reply({
          content: "❌ A template with that name already exists!",
          flags: MessageFlags.Ephemeral,
        });
      }

      await new Promise((resolve, reject) => {
        db.db.run(
          "INSERT INTO role_templates (guild_id, template_name, role_ids, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
          [
            interaction.guild.id,
            sanitizedName,
            JSON.stringify(manageableRoles),
            interaction.user.id,
            Date.now(),
          ],
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          }
        );
      });

      const roles = manageableRoles.map((id) => `<@&${id}>`).join(", ");

      const embed = new EmbedBuilder()
        .setTitle("✅ Role Template Created")
        .setDescription(
          `**Template:** \`${sanitizedName}\`\n**Roles:** ${roles}\n\n💡 Use \`/roletemplate apply template:${sanitizedName}\` to apply this template.`
        )
        .setColor(0x00ff00)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    } else if (subcommand === "apply") {
      const templateName = interaction.options.getString("template");
      
      // Input validation using security utility
      const templateValidation = CommandSecurity.validateInput(templateName, "Template name", 1, 100);
      if (templateValidation) return interaction.reply(templateValidation);

      // Sanitize template name
      const sanitizedTemplateName = CommandSecurity.sanitizeInput(templateName, 100);
      
      const user = interaction.options.getUser("user");
      const targetMember = await interaction.guild.members.fetch(user.id);
      
      // Security check using utility
      const securityCheck = await CommandSecurity.checkRoleManagementSecurity(
        interaction,
        PermissionFlagsBits.ManageRoles,
        targetMember
      );
      if (securityCheck) return interaction.reply(securityCheck);

      const member = targetMember;

      const template = await new Promise((resolve, reject) => {
        db.db.get(
          "SELECT * FROM role_templates WHERE guild_id = ? AND template_name = ?",
          [interaction.guild.id, sanitizedTemplateName],
          (err, row) => {
            if (err) {
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });

      if (!template) {
        return interaction.reply({
          content: "❌ Template not found!",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      const roleIds = JSON.parse(template.role_ids);
      
      // Filter roles bot can actually manage using security utility
      const manageableRoles = CommandSecurity.filterManageableRoles(
        roleIds,
        interaction.guild,
        botMember
      );

      if (manageableRoles.length === 0) {
        return interaction.editReply({
          content: "❌ I cannot manage any roles in this template! The bot's role may be too low.",
        });
      }

      const added = [];
      const failed = [];

      for (const role of manageableRoles) {
        try {
          if (member.roles.cache.has(role.id)) {
            continue; // Already has role
          }
          await member.roles.add(role);
          added.push(role);
        } catch (error) {
          failed.push(role);
        }
      }

      const embed = new EmbedBuilder()
        .setTitle("✅ Template Applied")
        .setDescription(
          `**Template:** \`${sanitizedTemplateName}\`\n**User:** ${user}\n\n` +
            (added.length > 0
              ? `✅ **Added:** ${added.map((r) => r.toString()).join(", ")}\n`
              : "") +
            (failed.length > 0
              ? `❌ **Failed:** ${failed.map((r) => r.name).join(", ")}`
              : "")
        )
        .setColor(added.length > 0 ? 0x00ff00 : 0xff0000)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } else if (subcommand === "list") {
      const templates = await new Promise((resolve, reject) => {
        db.db.all(
          "SELECT * FROM role_templates WHERE guild_id = ? ORDER BY created_at DESC",
          [interaction.guild.id],
          (err, rows) => {
            if (err) {
              reject(err);
            } else {
              resolve(rows || []);
            }
          }
        );
      });

      if (templates.length === 0) {
        return interaction.reply({
          content: "❌ No templates found!",
          flags: MessageFlags.Ephemeral,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("📋 Role Templates")
        .setDescription(
          templates
            .map((t) => {
              const roleIds = JSON.parse(t.role_ids);
              const roles = roleIds
                .map((id) => {
                  const role = interaction.guild.roles.cache.get(id);
                  return role ? role.name : `Unknown (${id})`;
                })
                .join(", ");
              // Sanitize template name to prevent XSS
              const safeName = (t.template_name || "").replace(/[<>]/g, "");
              return `**${safeName}**\n${roles || "No roles"}`;
            })
            .join("\n\n")
        )
        .setColor(0x5865f2)
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    } else if (subcommand === "delete") {
      const templateName = interaction.options.getString("template");

      // Input validation using security utility
      const templateValidation = CommandSecurity.validateInput(templateName, "Template name", 1, 100);
      if (templateValidation) return interaction.reply(templateValidation);

      // Sanitize template name
      const sanitizedTemplateName = CommandSecurity.sanitizeInput(templateName, 100);

      const result = await new Promise((resolve, reject) => {
        db.db.run(
          "DELETE FROM role_templates WHERE guild_id = ? AND template_name = ?",
          [interaction.guild.id, sanitizedTemplateName],
          function (err) {
            if (err) {
              reject(err);
            } else {
              resolve(this.changes);
            }
          }
        );
      });

      if (result === 0) {
        return interaction.reply({
          content: "❌ Template not found!",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.reply({
        content: `✅ Template \`${sanitizedTemplateName}\` deleted!`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
