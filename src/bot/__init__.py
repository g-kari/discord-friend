# Make src.bot a package
# Import discord_aiavatar_complete module to make it available as src.bot.discord_aiavatar_complete
import sys

# In test environment, don't import the main module to avoid dependency issues
if "pytest" not in sys.modules:
    from . import discord_aiavatar_complete
