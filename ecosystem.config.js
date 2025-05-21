// eslint-disable-next-line no-undef
module.exports = {
  apps: [
    {
      name: "aiavatar-bot",
      script: "src/bot/.venv/bin/python",
      args: "src/bot/discord_aiavatar_complete.py",
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm Z",
      max_size: "10M",
      time: true,
      combine_logs: true,
      env: {
        PYTHONUNBUFFERED: 1,
      },
    },
  ],

  deploy: {
    production: {
      user: "SSH_USERNAME",
      host: "SSH_HOSTMACHINE",
      ref: "origin/master",
      repo: "GIT_REPOSITORY",
      path: "DESTINATION_PATH",
      "pre-deploy-local": "",
      "post-deploy":
        "cd src/bot && curl -LsSf https://astral.sh/uv/install.sh | sh && uv venv && . .venv/bin/activate && uv pip install -r requirements.txt && pm2 reload ecosystem.config.js --env production",
      "pre-setup": "",
    },
  },
};
