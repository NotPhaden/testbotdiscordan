require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const LEAGUE_NAME = process.env.LEAGUE_NAME || 'MGKK';
const API_BASE = 'https://ps99.biggamesapi.io/v1';
const STATE_FILE = path.join(__dirname, 'state.json');
const LOGO_FILE = path.join(__dirname, 'logo.png');

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN.');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('Missing DISCORD_CHANNEL_ID.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function defaultState() {
  return {
    rank: null,
    points: null,
    lastCheck: null,
    ranking: null,
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return defaultState();

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    return {
      ...defaultState(),
      ...state,
    };
  } catch (error) {
    console.error(`[STATE] Could not read state.json: ${error.message}`);
    return defaultState();
  }
}

function saveState(state) {
  const tempFile = `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(tempFile, STATE_FILE);
}

async function api(pathname) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'MGKK-Discord-Bot/3.0',
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let json;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid API response (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      json?.error?.message ||
      json?.message ||
      `BIG Games API returned ${response.status}`
    );
  }

  if (json?.status === 'error') {
    throw new Error(
      json?.error?.message ||
      'BIG Games API returned an error.'
    );
  }

  return json;
}

async function getLeague() {
  const response = await api(
    `/leagues/${encodeURIComponent(LEAGUE_NAME)}`
  );

  return response?.data ?? response;
}

async function getLeagueRanking() {
  const pageSize = 100;
  const ranking = [];

  for (let page = 1; page <= 1000; page++) {
    const response = await api(
      `/leagues/?page=${page}&pageSize=${pageSize}`
    );

    const data = response?.data;

    if (!data || !Array.isArray(data.leagues)) {
      throw new Error('Invalid league listing response.');
    }

    const leagues = data.leagues;

    if (leagues.length === 0) {
      break;
    }

    for (const league of leagues) {
      const name = String(league?.Name || '').trim();

      if (name) {
        ranking.push(name);
      }
    }

    if (leagues.length < pageSize) {
      break;
    }
  }

  const exactIndex = ranking.findIndex(
    name =>
      name.toLowerCase() === LEAGUE_NAME.toLowerCase()
  );

  if (exactIndex === -1) {
    throw new Error(
      `Could not find ${LEAGUE_NAME} in the league rankings.`
    );
  }

  return {
    rank: exactIndex + 1,
    ranking,
  };
}

function getPassedLeagues(
  oldRank,
  newRank,
  oldRanking,
  currentRanking
) {
  if (
    !Array.isArray(oldRanking) ||
    !Array.isArray(currentRanking)
  ) {
    return [];
  }

  if (newRank < oldRank) {
    // MGKK moved UP.
    // These are the leagues that were immediately ahead
    // of MGKK in the previous snapshot.
    return oldRanking.slice(
      newRank - 1,
      oldRank - 1
    );
  }

  // MGKK moved DOWN.
  // These are the leagues that are now immediately
  // ahead of MGKK.
  return currentRanking.slice(
    oldRank,
    newRank
  );
}

function formatLeagueList(leagues) {
  if (!leagues.length) {
    return '• Could not determine the leagues for this change.';
  }

  const maxItems = 15;
  const visible = leagues.slice(0, maxItems);

  let text = visible
    .map(name => `• **${name}**`)
    .join('\n');

  if (leagues.length > maxItems) {
    text += `\n• **+${leagues.length - maxItems} more**`;
  }

  return text;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function formatRank(rank) {
  return `#${formatNumber(rank)}`;
}

function createEmbed(
  oldRank,
  newRank,
  points,
  movedLeagues
) {
  const movedUp = newRank < oldRank;
  const difference = Math.abs(oldRank - newRank);

  const title = movedUp
    ? `📈 ${LEAGUE_NAME} — Increased !`
    : `📉 ${LEAGUE_NAME} — Decreased !`;

  const description = movedUp
    ? `**${LEAGUE_NAME}** Increased **${difference} position${difference === 1 ? '' : 'i'}** In League LeaderBoard!`
    : `**${LEAGUE_NAME}** Decreased **${difference} position${difference === 1 ? '' : 'i'}** In League LeaderBoard!`;

  const movementFieldName = movedUp
    ? '⬆️ Overtook'
    : '⬇️ Overtaken by';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .addFields(
      {
        name: '⬅️ Previous place',
        value: formatRank(oldRank),
        inline: true,
      },
      {
        name: '🏆 Current place',
        value: formatRank(newRank),
        inline: true,
      },
      {
        name: '💎 Points',
        value: formatNumber(points),
        inline: true,
      },
      {
        name: movementFieldName,
        value: formatLeagueList(movedLeagues),
        inline: false,
      }
    )
    .setTimestamp()
    .setFooter({
      text: 'MGKK League • MADE BY BRAT',
    });

  if (fs.existsSync(LOGO_FILE)) {
    embed.setThumbnail('attachment://logo.png');
  }

  return embed;
}

async function sendRankChange(
  oldRank,
  newRank,
  points,
  movedLeagues
) {
  const channel = await client.channels.fetch(CHANNEL_ID);

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      'Discord channel could not be found or is not text-based.'
    );
  }

  const payload = {
    embeds: [
      createEmbed(
        oldRank,
        newRank,
        points,
        movedLeagues
      ),
    ],
  };

  if (fs.existsSync(LOGO_FILE)) {
    payload.files = [
      new AttachmentBuilder(LOGO_FILE, {
        name: 'logo.png',
      }),
    ];
  }

  await channel.send(payload);
}

async function checkRank() {
  console.log(
    `[${new Date().toISOString()}] Checking ${LEAGUE_NAME}...`
  );

  const league = await getLeague();

  if (!league || typeof league !== 'object') {
    throw new Error('League data is invalid.');
  }

  const points = Number(league.Points || 0);

  if (!Number.isFinite(points) || points <= 0) {
    throw new Error(
      `Could not read ${LEAGUE_NAME} points.`
    );
  }

  const { rank, ranking } =
    await getLeagueRanking();

  console.log(
    `${LEAGUE_NAME}: rank ${formatRank(rank)} | ${formatNumber(points)} points`
  );

  const state = loadState();
  const now = new Date().toISOString();

  // First run or migration from the old state format.
  if (
    state.rank === null ||
    !Number.isFinite(Number(state.rank)) ||
    !Array.isArray(state.ranking)
  ) {
    saveState({
      rank,
      points,
      lastCheck: now,
      ranking,
    });

    console.log(
      `Initial ranking snapshot saved: ${formatRank(rank)}`
    );

    return;
  }

  const oldRank = Number(state.rank);

  if (oldRank === rank) {
    // Update the snapshot every check.
    // This makes the next movement compare against
    // the immediately previous ranking.
    saveState({
      rank,
      points,
      lastCheck: now,
      ranking,
    });

    console.log(
      'Rank unchanged. Ranking snapshot updated.'
    );

    return;
  }

  const movedLeagues = getPassedLeagues(
    oldRank,
    rank,
    state.ranking,
    ranking
  );

  await sendRankChange(
    oldRank,
    rank,
    points,
    movedLeagues
  );

  console.log(
    `Rank changed: ${formatRank(oldRank)} -> ${formatRank(rank)}`
  );

  console.log(
    `${rank < oldRank ? 'Overtook' : 'Overtaken by'}: ${
      movedLeagues.length
        ? movedLeagues.join(', ')
        : 'unknown'
    }`
  );

  saveState({
    rank,
    points,
    lastCheck: now,
    ranking,
  });
}

client.once('ready', async () => {
  console.log('====================================');
  console.log('MGKK Discord Bot');
  console.log('====================================');
  console.log(
    `Logged in as: ${client.user.tag}`
  );
  console.log(
    `Watching league: ${LEAGUE_NAME}`
  );
  console.log(
    `Channel: ${CHANNEL_ID}`
  );
  console.log(
    'Mode: GitHub Actions one-shot check'
  );
  console.log('====================================');

  try {
    await checkRank();
  } catch (error) {
    console.error(
      `[CHECK ERROR] ${error?.message || error}`
    );

    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

client.on('error', error => {
  console.error(
    `[DISCORD ERROR] ${error.message}`
  );
});

process.on('unhandledRejection', error => {
  console.error(
    '[UNHANDLED REJECTION]',
    error
  );

  process.exitCode = 1;
});

process.on('uncaughtException', error => {
  console.error(
    '[UNCAUGHT EXCEPTION]',
    error
  );

  process.exitCode = 1;
});

client.login(TOKEN).catch(error => {
  console.error(
    `[LOGIN ERROR] ${error.message}`
  );

  process.exit(1);
});