# MGKK Discord Rank Bot

A GitHub Actions version of the MGKK Discord rank monitor.

It checks the MGKK league through the BIG Games public API every 5 minutes and sends a Discord embed when the league's ranking position changes.

## What it does

- Checks MGKK every 5 minutes.
- Gets the league's exact position from the paginated league ranking.
- Saves the last known rank in `state.json`.
- Does not send a message on the first run.
- Sends an **AVANSARE** message when the rank improves.
- Sends a **DEZAVANSARE** message when the rank gets worse.
- Includes previous rank, current rank and league points.
- Uses `logo.png` as the embed thumbnail.
- Runs through GitHub Actions, so your computer does not need to stay on.

## GitHub setup

1. Create a GitHub repository and upload all files from this project.
2. Do **not** upload a `.env` file or your real Discord token.
3. Open the repository on GitHub.
4. Go to **Settings → Secrets and variables → Actions**.
5. Add a repository secret named `DISCORD_TOKEN`.
6. Put your Discord bot token into `DISCORD_TOKEN`.
7. Add another repository secret named `DISCORD_CHANNEL_ID`.
8. Put the target Discord channel ID into `DISCORD_CHANNEL_ID`.
9. Make sure the Discord bot has **View Channel**, **Send Messages** and **Embed Links** permissions.
10. Open **Actions → MGKK Discord Bot**.
11. Use **Run workflow** once to test it.

After that, the scheduled workflow checks the rank automatically every 5 minutes.

## Important: Discord token security

Never put the real token in `bot.js`, `.env.example`, `README.md`, `state.json`, or any public GitHub file.

If the token was ever uploaded publicly, regenerate it in the Discord Developer Portal before using the bot again.

## Repository files

```text
bot.js
package.json
package-lock.json
state.json
logo.png
.env.example
.gitignore
.github/workflows/bot.yml
README.md
```

## Local testing

You can still test the bot locally with:

```bash
npm install
npm start
```

Create a local `.env` containing:

```env
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
DISCORD_CHANNEL_ID=YOUR_CHANNEL_ID
LEAGUE_NAME=MGKK
```

The `.env` file is ignored by Git.
