require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const LEAGUE_NAME = process.env.LEAGUE_NAME || 'MGKK';

const API_BASE = 'https://ps99.biggamesapi.io/v1';

const STATE_FILE = path.join(__dirname, 'state.json');
const LOGO_FILE = path.join(__dirname, 'logo.png');
const CARD_FILE = path.join(__dirname, 'league-card.png');

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

/* =========================================================
   STATE
========================================================= */

function defaultState() {
  return {
    rank: null,
    points: null,
    lastCheck: null,
    ranking: null,
    history: [],
    dashboardMessageId: null,
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return defaultState();
    }

    const state = JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );

    return {
      ...defaultState(),
      ...state,
      history: Array.isArray(state.history)
        ? state.history
        : [],
    };
  } catch (error) {
    console.error(
      `[STATE] Could not read state.json: ${error.message}`
    );

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

/* =========================================================
   API
========================================================= */

async function api(pathname) {
  const response = await fetch(
    `${API_BASE}${pathname}`,
    {
      headers: {
        accept: 'application/json',
        'user-agent': 'MGKK-Discord-Bot/4.0',
      },
      signal: AbortSignal.timeout(15000),
    }
  );

  const text = await response.text();

  let json;

  try {
    json = text
      ? JSON.parse(text)
      : null;
  } catch {
    throw new Error(
      `Invalid API response (${response.status})`
    );
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

  for (
    let page = 1;
    page <= 10000;
    page++
  ) {
    const response = await api(
      `/leagues/?page=${page}&pageSize=${pageSize}&sort=Points&sortOrder=desc`
    );

    const data = response?.data;

    if (
      !data ||
      !Array.isArray(data.leagues)
    ) {
      throw new Error(
        'Invalid league listing response.'
      );
    }

    const leagues = data.leagues;

    if (leagues.length === 0) {
      break;
    }

    for (const league of leagues) {
      const name = String(
        league?.Name || ''
      ).trim();

      if (name) {
        ranking.push(name);
      }
    }

    if (leagues.length < pageSize) {
      break;
    }
  }

  const exactIndex =
    ranking.findIndex(
      name =>
        name.toLowerCase() ===
        LEAGUE_NAME.toLowerCase()
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
    return oldRanking.slice(
      newRank - 1,
      oldRank - 1
    );
  }

  return currentRanking.slice(
    oldRank,
    newRank
  );
}

/* =========================================================
   FORMATTERS
========================================================= */

function formatNumber(value) {
  return Number(value || 0)
    .toLocaleString('en-US');
}

function formatRank(rank) {
  return `#${formatNumber(rank)}`;
}

function formatCompact(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) {
    return '0';
  }

  if (Math.abs(n) >= 1e9) {
    return `${(
      n / 1e9
    ).toFixed(2)}m`
      .replace('m', 'b');
  }

  if (Math.abs(n) >= 1e6) {
    return `${(
      n / 1e6
    ).toFixed(2)}m`;
  }

  if (Math.abs(n) >= 1e3) {
    return `${(
      n / 1e3
    ).toFixed(2)}k`;
  }

  return `${Math.round(n)}`;
}

function formatDelta(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) {
    return '—';
  }

  if (n === 0) {
    return '0';
  }

  return `${
    n > 0 ? '+' : ''
  }${formatCompact(n)}`;
}

function formatHoursSince(unixSeconds) {
  if (!unixSeconds) {
    return '—';
  }

  const hours = Math.max(
    0,
    (
      Date.now() -
      Number(unixSeconds) * 1000
    ) / 3600000
  );

  if (hours < 1) {
    return `${Math.round(
      hours * 60
    )}m`;
  }

  return `${Math.floor(hours)}h`;
}

function formatSnapshotAge(timestamp) {
  const ms = Math.max(
    0,
    Date.now() -
      Number(timestamp)
  );

  const minutes = Math.floor(
    ms / 60000
  );

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes} minute${
      minutes === 1 ? '' : 's'
    } ago`;
  }

  const hours = Math.floor(
    minutes / 60
  );

  return `${hours} hour${
    hours === 1 ? '' : 's'
  } ago`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shorten(value, max) {
  const text = String(value ?? '');

  return text.length > max
    ? `${text.slice(
        0,
        max - 1
      )}…`
    : text;
}

/* =========================================================
   ROBLOX IMAGES
========================================================= */

function avatarUrl(userId) {
  return (
    'https://thumbnails.roblox.com/v1/users/avatar-headshot' +
    `?userIds=${encodeURIComponent(userId)}` +
    '&size=150x150' +
    '&format=Png' +
    '&isCircular=true'
  );
}

async function fetchBuffer(url) {
  try {
    const response = await fetch(
      url,
      {
        headers: {
          'user-agent':
            'MGKK-Discord-Bot/4.0',
        },
        signal:
          AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      return null;
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  } catch {
    return null;
  }
}

async function resolveAvatar(userId) {
  const response =
    await fetchBuffer(
      avatarUrl(userId)
    );

  if (!response) {
    return null;
  }

  try {
    return await sharp(response)
      .resize(64, 64, {
        fit: 'cover',
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

async function resolveLeagueIcon(icon) {
  const match = String(
    icon || ''
  ).match(
    /rbxassetid:\/\/(\d+)/i
  );

  if (!match) {
    return null;
  }

  const url =
    `https://thumbnails.roblox.com/v1/assets?assetIds=${match[1]}` +
    '&returnPolicy=PlaceHolder' +
    '&size=420x420' +
    '&format=Png' +
    '&isCircular=false';

  const response =
    await fetchBuffer(url);

  if (!response) {
    return null;
  }

  try {
    const json = JSON.parse(
      response.toString('utf8')
    );

    const imageUrl =
      json?.data?.[0]?.imageUrl;

    return imageUrl
      ? fetchBuffer(imageUrl)
      : null;
  } catch {
    return null;
  }
}

/* =========================================================
   MEMBERS
========================================================= */

function getContributors(league) {
  const contributionMap =
    new Map(
      (
        Array.isArray(
          league.PointContributions
        )
          ? league.PointContributions
          : []
      ).map(entry => [
        String(entry.UserID),
        entry,
      ])
    );

  const owner =
    league.Owner &&
    league.Owner.UserID != null
      ? league.Owner
      : null;

  /*
    Owner is separate from Members.
    Members contains the other league members.
  */

  const members = [
    ...(owner ? [owner] : []),
    ...(
      Array.isArray(
        league.Members
      )
        ? league.Members
        : []
    ),
  ];

  const seen = new Set();

  return members
    .filter(member => {
      const id = String(
        member?.UserID ?? ''
      );

      if (!id) {
        return false;
      }

      if (seen.has(id)) {
        return false;
      }

      seen.add(id);

      return true;
    })
    .map(member => {
      const id = String(
        member.UserID
      );

      const contribution =
        contributionMap.get(id);

      return {
        userId: member.UserID,

        name: String(
          member.DisplayName ||
          contribution?.DisplayName ||
          id
        ),

        points: Number(
          contribution?.Points || 0
        ),

        timestamp: Number(
          contribution?.Timestamp || 0
        ),
      };
    })
    .sort(
      (a, b) =>
        b.points - a.points
    );
}

/* =========================================================
   HISTORY
========================================================= */

function makeSnapshot(
  league,
  contributors
) {
  return {
    timestamp: Date.now(),

    points: Number(
      league.Points || 0
    ),

    members:
      contributors.map(
        member => ({
          userId:
            member.userId,

          name:
            member.name,

          points:
            member.points,
        })
      ),
  };
}

function trimHistory(history) {
  const cutoff =
    Date.now() -
    72 * 3600000;

  return history
    .filter(
      entry =>
        Number(
          entry.timestamp
        ) >= cutoff
    )
    .slice(-73);
}

function findHistorySnapshot(
  history,
  targetMs,
  toleranceMs
) {
  let best = null;
  let bestDistance =
    Infinity;

  for (
    const snapshot of history
  ) {
    const distance =
      Math.abs(
        Number(
          snapshot.timestamp
        ) - targetMs
      );

    if (
      Number(
        snapshot.timestamp
      ) <=
        targetMs +
          toleranceMs &&
      distance < bestDistance
    ) {
      best = snapshot;
      bestDistance =
        distance;
    }
  }

  return best;
}

function getMemberDelta(
  history,
  userId,
  hoursAgo
) {
  const current =
    history[
      history.length - 1
    ];

  const currentMember =
    current?.members?.find(
      member =>
        String(
          member.userId
        ) ===
        String(userId)
    );

  if (!currentMember) {
    return null;
  }

  const target =
    Date.now() -
    hoursAgo * 3600000;

  const tolerance =
    hoursAgo <= 1
      ? 45 * 60000
      : 3 * 3600000;

  const oldSnapshot =
    findHistorySnapshot(
      history,
      target,
      tolerance
    );

  if (!oldSnapshot) {
    return null;
  }

  const oldMember =
    oldSnapshot.members?.find(
      member =>
        String(
          member.userId
        ) ===
        String(userId)
    );

  if (!oldMember) {
    return null;
  }

  return (
    Number(
      currentMember.points || 0
    ) -
    Number(
      oldMember.points || 0
    )
  );
}

/* =========================================================
   HOURLY DATA
========================================================= */

function makeHourlySnapshots(
  history,
  hours = 24
) {
  const valid =
    Array.isArray(history)
      ? history.filter(
          snapshot =>
            Number.isFinite(
              Number(
                snapshot?.timestamp
              )
            )
        )
      : [];

  const now = Date.now();

  const result = [];

  for (
    let h = hours;
    h >= 0;
    h--
  ) {
    const target =
      now -
      h * 3600000;

    let best = null;
    let bestDistance =
      Infinity;

    for (
      const snapshot of valid
    ) {
      const distance =
        Math.abs(
          Number(
            snapshot.timestamp
          ) - target
        );

      if (
        distance <
          bestDistance &&
        distance <=
          35 * 60000
      ) {
        best =
          snapshot;

        bestDistance =
          distance;
      }
    }

    if (best) {
      result.push({
        ...best,
        label:
          h === 0
            ? 'Now'
            : `${h}h`,
      });
    }
  }

  return result;
}

function getLeaguePointsPerHour(
  history
) {
  const snapshots =
    Array.isArray(history)
      ? history
      : [];

  if (
    snapshots.length < 2
  ) {
    return null;
  }

  const now =
    snapshots[
      snapshots.length - 1
    ];

  const target =
    Number(now.timestamp) -
    3600000;

  let old = null;
  let distance =
    Infinity;

  for (
    const snapshot of snapshots
  ) {
    const d =
      Math.abs(
        Number(
          snapshot.timestamp
        ) - target
      );

    if (
      Number(
        snapshot.timestamp
      ) <=
        Number(
          now.timestamp
        ) &&
      d < distance
    ) {
      old = snapshot;
      distance = d;
    }
  }

  if (
    !old ||
    distance >
      35 * 60000
  ) {
    return null;
  }

  const elapsedHours =
    (
      Number(
        now.timestamp
      ) -
      Number(
        old.timestamp
      )
    ) / 3600000;

  if (
    elapsedHours <= 0
  ) {
    return null;
  }

  return (
    (
      Number(
        now.points || 0
      ) -
      Number(
        old.points || 0
      )
    ) /
    elapsedHours
  );
}

/* =========================================================
   CHART
========================================================= */

function makeChartSvg(
  history,
  contributors
) {
  const width = 1320;
  const height = 410;

  const left = 65;
  const right = 25;
  const top = 28;
  const bottom = 52;

  const chartW =
    width -
    left -
    right;

  const chartH =
    height -
    top -
    bottom;

  const snapshots =
    makeHourlySnapshots(
      history,
      24
    );

  const colors = [
    '#12bfff',
    '#ff3da8',
    '#ffab1a',
    '#36e0aa',
  ];

  const values =
    snapshots.flatMap(
      snapshot =>
        (
          snapshot.members ||
          []
        ).map(
          member =>
            Number(
              member.points || 0
            )
        )
    );

  const maxValue =
    Math.max(
      1,
      ...values
    );

  const yMax =
    Math.ceil(
      maxValue / 10000000
    ) *
      10000000 ||
    maxValue;

  const x = index => {
    if (
      snapshots.length <= 1
    ) {
      return (
        left +
        chartW / 2
      );
    }

    return (
      left +
      (
        index /
        (
          snapshots.length -
          1
        )
      ) *
        chartW
    );
  };

  const y = value =>
    top +
    chartH -
    (
      Number(value || 0) /
      yMax
    ) *
      chartH;

  /* Grid */

  const grid = [];

  for (
    let i = 0;
    i <= 5;
    i++
  ) {
    const value =
      (yMax / 5) *
      i;

    const yy = y(value);

    grid.push(`
      <line
        x1="${left}"
        y1="${yy}"
        x2="${left + chartW}"
        y2="${yy}"
        stroke="#303238"
        stroke-width="1"
      />

      <text
        x="${left - 10}"
        y="${yy + 5}"
        text-anchor="end"
        fill="#858891"
        font-size="13"
        font-family="Arial"
      >
        ${xmlEscape(
          formatCompact(
            value
          )
        )}
      </text>
    `);
  }

  /* Member lines */

  const series =
    contributors
      .map(
        (
          member,
          seriesIndex
        ) => {
          const color =
            colors[
              seriesIndex %
                colors.length
            ];

          const vals =
            snapshots.map(
              snapshot => {
                const found =
                  (
                    snapshot.members ||
                    []
                  ).find(
                    item =>
                      String(
                        item.userId
                      ) ===
                      String(
                        member.userId
                      )
                  );

                return Number(
                  found?.points ||
                    0
                );
              }
            );

          if (
            vals.length === 0
          ) {
            return '';
          }

          const linePoints =
            vals
              .map(
                (
                  value,
                  index
                ) =>
                  `${x(
                    index
                  )},${y(
                    value
                  )}`
              )
              .join(' ');

          const areaPoints =
            `${left},${top + chartH} ` +
            `${linePoints} ` +
            `${left + chartW},${top + chartH}`;

          const circles =
            vals
              .map(
                (
                  value,
                  index
                ) => `
                  <circle
                    cx="${x(index)}"
                    cy="${y(value)}"
                    r="3.5"
                    fill="${color}"
                  />
                `
              )
              .join('');

          return `
            <polygon
              points="${areaPoints}"
              fill="${color}"
              opacity="0.10"
            />

            <polyline
              points="${linePoints}"
              fill="none"
              stroke="${color}"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />

            ${circles}
          `;
        }
      )
      .join('');

  /* X labels */

  const xLabels =
    snapshots
      .map(
        (
          snapshot,
          index
        ) => {
          if (
            snapshots.length >
              13 &&
            index % 2 !== 0
          ) {
            return '';
          }

          return `
            <text
              x="${x(index)}"
              y="${height - 16}"
              text-anchor="middle"
              fill="#858891"
              font-size="13"
              font-family="Arial"
              transform="rotate(-45 ${x(index)} ${height - 16})"
            >
              ${xmlEscape(
                snapshot.label
              )}
            </text>
          `;
        }
      )
      .join('');

  return `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
    >

      <rect
        width="100%"
        height="100%"
        fill="#1d1e22"
      />

      ${grid.join('')}

      ${series}

      ${xLabels}

    </svg>
  `;
}

/* =========================================================
   LEAGUE CARD
========================================================= */

async function makeLeagueCard(
  league,
  contributors,
  history
) {
  const width = 1400;

  const tableTop = 320;

  const rowH = 60;

  const chartTop =
    tableTop +
    32 +
    rowH *
      contributors.length +
    14;

  const chartHeight = 410;

  const height =
    chartTop +
    chartHeight +
    24;

  const iconBuffer =
    await resolveLeagueIcon(
      league.Icon
    );

  const avatarBuffers =
    await Promise.all(
      contributors.map(
        member =>
          resolveAvatar(
            member.userId
          )
      )
    );

  const defs = `
    <defs>

      <filter
        id="shadow"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
      >
        <feDropShadow
          dx="0"
          dy="6"
          stdDeviation="12"
          flood-color="#000000"
          flood-opacity="0.35"
        />
      </filter>

      <clipPath id="iconClip">
        <rect
          x="1190"
          y="38"
          width="150"
          height="150"
          rx="16"
        />
      </clipPath>

    </defs>
  `;

  const iconImage =
    iconBuffer
      ? `
        <image
          href="data:image/png;base64,${iconBuffer.toString(
            'base64'
          )}"
          x="1190"
          y="38"
          width="150"
          height="150"
          preserveAspectRatio="xMidYMid slice"
          clip-path="url(#iconClip)"
        />
      `
      : `
        <rect
          x="1190"
          y="38"
          width="150"
          height="150"
          rx="16"
          fill="#303238"
        />
      `;

  const title =
    xmlEscape(
      `League ${
        league.Name ||
        LEAGUE_NAME
      }`
    );

  const points =
    Number(
      league.Points || 0
    );

  const snapshotAge =
    history.length
      ? formatSnapshotAge(
          history[
            history.length - 1
          ].timestamp
        )
      : 'just now';

  const owner =
    league.Owner
      ?.DisplayName ||
    'Unknown';

  const level =
    Number(
      league.Level || 1
    );

  const memberCount =
    contributors.length;

  const capacity =
    Number(
      league.MemberCapacity ||
        memberCount ||
        4
    );

  const hourlyRate =
    getLeaguePointsPerHour(
      history
    );

  const rankText =
    formatRank(
      currentRank
    );

  /* =======================================================
     TABLE HEADER
  ======================================================= */

  const headers = [
    ['GLOBAL RANK', 28],
    ['PLAYER', 190],
    ['POINTS', 610],
    ['+1H', 795],
    ['+24H', 925],
    ['OFF TIME', 1060],
    ['BETTER THAN', 1200],
  ];

  const headerSvg =
    headers
      .map(
        ([text, x]) => `
          <text
            x="${x}"
            y="${tableTop - 15}"
            fill="#a8aab2"
            font-size="15"
            font-weight="700"
            font-family="Arial"
          >
            ${text}
          </text>
        `
      )
      .join('');

  /* =======================================================
     MEMBER ROWS
  ======================================================= */

  const colors = [
    '#12bfff',
    '#ff3da8',
    '#ffab1a',
    '#36e0aa',
  ];

  const rows =
    contributors
      .map(
        (
          member,
          index
        ) => {
          const y0 =
            tableTop +
            index * rowH;

          const color =
            colors[
              index %
                colors.length
            ];

          const delta1h =
            getMemberDelta(
              history,
              member.userId,
              1
            );

          const delta24h =
            getMemberDelta(
              history,
              member.userId,
              24
            );

          const share =
            points > 0
              ? (
                  member.points /
                  points
                ) *
                100
              : 0;

          /*
            Individual global player rank is not available
            from the current public league data.

            We intentionally do NOT invent a rank.
          */

          const globalRank =
            member.globalRank
              ? formatRank(
                  member.globalRank
                )
              : '—';

          const avatar =
            avatarBuffers[index]
              ? `
                <image
                  href="data:image/png;base64,${avatarBuffers[
                    index
                  ].toString(
                    'base64'
                  )}"
                  x="160"
                  y="${y0 + 7}"
                  width="46"
                  height="46"
                />
              `
              : `
                <circle
                  cx="183"
                  cy="${y0 + 30}"
                  r="23"
                  fill="#3a3b40"
                />
              `;

          return `
            <rect
              x="20"
              y="${y0}"
              width="1360"
              height="${rowH - 2}"
              fill="#20272b"
              opacity="0.98"
            />

            <rect
              x="20"
              y="${y0}"
              width="6"
              height="${rowH - 2}"
              fill="${color}"
            />

            <text
              x="38"
              y="${y0 + 38}"
              fill="${color}"
              font-size="20"
              font-weight="700"
              font-family="Arial"
            >
              ${globalRank}
            </text>

            ${avatar}

            <text
              x="220"
              y="${y0 + 38}"
              fill="#f0f1f4"
              font-size="20"
              font-weight="700"
              font-family="Arial"
            >
              ${xmlEscape(
                shorten(
                  member.name,
                  25
                )
              )}
            </text>

            <text
              x="610"
              y="${y0 + 38}"
              fill="${color}"
              font-size="20"
              font-weight="700"
              font-family="Arial"
            >
              ★ ${xmlEscape(
                formatCompact(
                  member.points
                )
              )}
            </text>

            <text
              x="795"
              y="${y0 + 38}"
              fill="#f0f1f4"
              font-size="19"
              font-weight="700"
              font-family="Arial"
            >
              ${xmlEscape(
                formatDelta(
                  delta1h
                )
              )}
            </text>

            <text
              x="925"
              y="${y0 + 38}"
              fill="#f0f1f4"
              font-size="19"
              font-weight="700"
              font-family="Arial"
            >
              ${xmlEscape(
                formatDelta(
                  delta24h
                )
              )}
            </text>

            <text
              x="1060"
              y="${y0 + 38}"
              fill="#f0f1f4"
              font-size="19"
              font-weight="700"
              font-family="Arial"
            >
              ${xmlEscape(
                formatHoursSince(
                  member.timestamp
                )
              )}
            </text>

            <text
              x="1200"
              y="${y0 + 38}"
              fill="${color}"
              font-size="19"
              font-weight="700"
              font-family="Arial"
            >
              ${share.toFixed(1)}%
            </text>
          `;
        }
      )
      .join('');

  /* =======================================================
     CHART
  ======================================================= */

  const chartSvg =
    makeChartSvg(
      history,
      contributors
    ).replace(
      /^<svg[^>]*>|<\/svg>$/g,
      ''
    );

  const chartInner =
    chartSvg.replace(
      /width="1320" height="410" viewBox="0 0 1320 410"/,
      `x="40" y="${chartTop}" width="1320" height="410"`
    );

  /* =======================================================
     FINAL SVG
  ======================================================= */

  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
    >

      ${defs}

      <rect
        width="100%"
        height="100%"
        rx="22"
        fill="#191a1e"
      />

      <rect
        x="10"
        y="10"
        width="1380"
        height="${height - 20}"
        rx="22"
        fill="#242529"
        filter="url(#shadow)"
      />

      <!-- TITLE -->

      <text
        x="55"
        y="82"
        fill="#f0f1f4"
        font-size="38"
        font-weight="800"
        font-family="Arial"
      >
        ${title}
      </text>

      ${iconImage}

      <!-- STATS -->

      <text
        x="55"
        y="125"
        fill="#e8e9ec"
        font-size="23"
        font-weight="700"
        font-family="Arial"
      >
        Points:
        ${xmlEscape(
          formatCompact(points)
        )}
        ${
          hourlyRate != null
            ? ` (${xmlEscape(
                formatCompact(
                  hourlyRate
                )
              )}/h)`
            : ''
        }
      </text>

      <text
        x="55"
        y="161"
        fill="#e8e9ec"
        font-size="23"
        font-weight="700"
        font-family="Arial"
      >
        Global Rank:
        ${xmlEscape(
          rankText
        )}
      </text>

      <text
        x="55"
        y="197"
        fill="#e8e9ec"
        font-size="23"
        font-weight="700"
        font-family="Arial"
      >
        Level: ${level}
      </text>

      <text
        x="55"
        y="233"
        fill="#e8e9ec"
        font-size="23"
        font-weight="700"
        font-family="Arial"
      >
        Stats snapshot:
        ${xmlEscape(
          snapshotAge
        )}
      </text>

      <text
        x="55"
        y="262"
        fill="#e8e9ec"
        font-size="23"
        font-weight="700"
        font-family="Arial"
      >
        Members:
        ${memberCount}/${capacity}
      </text>

      <text
        x="55"
        y="294"
        fill="#e8e9ec"
        font-size="23"
        font-weight="700"
        font-family="Arial"
      >
        Owner:
        ${xmlEscape(owner)}
      </text>

      <line
        x1="55"
        y1="310"
        x2="1345"
        y2="310"
        stroke="#6a6b70"
        stroke-width="1"
      />

      ${headerSvg}

      ${rows}

      ${chartInner}

    </svg>
  `;

  await sharp(
    Buffer.from(svg)
  )
    .png()
    .toFile(CARD_FILE);

  return CARD_FILE;
}

/* =========================================================
   RANK CHANGE EMBED
========================================================= */

function createMovementEmbed(
  oldRank,
  newRank,
  points,
  movedLeagues
) {
  const movedUp =
    newRank < oldRank;

  const difference =
    Math.abs(
      oldRank - newRank
    );

  const title =
    movedUp
      ? `📈 ${LEAGUE_NAME} — Increased!`
      : `📉 ${LEAGUE_NAME} — Decreased!`;

  const description =
    movedUp
      ? `**${LEAGUE_NAME}** increased **${difference} position${
          difference === 1
            ? ''
            : 's'
        }** in the League Leaderboard!`
      : `**${LEAGUE_NAME}** decreased **${difference} position${
          difference === 1
            ? ''
            : 's'
        }** in the League Leaderboard!`;

  const visible =
    movedLeagues.slice(
      0,
      15
    );

  const list =
    visible.length
      ? visible
          .map(
            name =>
              `• **${name}**`
          )
          .join('\n')
      : '• Could not determine the leagues for this change.';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      description
    )
    .addFields(
      {
        name:
          '⬅️ Previous place',

        value:
          formatRank(
            oldRank
          ),

        inline: true,
      },

      {
        name:
          '🏆 Current place',

        value:
          formatRank(
            newRank
          ),

        inline: true,
      },

      {
        name:
          '💎 Points',

        value:
          formatNumber(
            points
          ),

        inline: true,
      },

      {
        name:
          movedUp
            ? '⬆️ Overtook'
            : '⬇️ Overtaken by',

        value: list,

        inline: false,
      }
    )
    .setTimestamp()
    .setFooter({
      text:
        'MGKK League • MADE BY BRAT',
    });
}

/* =========================================================
   SEND RANK CHANGE
========================================================= */

async function sendRankChange(
  oldRank,
  newRank,
  points,
  movedLeagues
) {
  const channel =
    await client.channels.fetch(
      CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      'Discord channel could not be found or is not text-based.'
    );
  }

  const payload = {
    embeds: [
      createMovementEmbed(
        oldRank,
        newRank,
        points,
        movedLeagues
      ),
    ],
  };

  if (
    fs.existsSync(
      LOGO_FILE
    )
  ) {
    payload.files = [
      new AttachmentBuilder(
        LOGO_FILE,
        {
          name: 'logo.png',
        }
      ),
    ];
  }

  await channel.send(
    payload
  );
}

/* =========================================================
   SEND / UPDATE DASHBOARD
========================================================= */

async function sendLeagueCard(
  league,
  contributors,
  history,
  existingMessageId
) {
  const channel =
    await client.channels.fetch(
      CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      'Discord channel could not be found or is not text-based.'
    );
  }

  const card =
    await makeLeagueCard(
      league,
      contributors,
      history
    );

  const file =
    new AttachmentBuilder(
      card,
      {
        name:
          'league-card.png',
      }
    );

  if (
    existingMessageId
  ) {
    try {
      const message =
        await channel.messages.fetch(
          existingMessageId
        );

      await message.edit({
        content: '',
        embeds: [],
        attachments: [],
        files: [file],
      });

      return message.id;
    } catch (error) {
      console.warn(
        `[DASHBOARD] Could not update message ${existingMessageId}: ${error.message}`
      );
    }
  }

  const message =
    await channel.send({
      files: [file],
    });

  return message.id;
}

/* =========================================================
   CHECK
========================================================= */

let currentRank = 0;

async function checkRank() {
  console.log(
    `[${new Date().toISOString()}] Checking ${LEAGUE_NAME}...`
  );

  const [
    league,
    {
      rank,
      ranking,
    },
  ] = await Promise.all([
    getLeague(),
    getLeagueRanking(),
  ]);

  if (
    !league ||
    typeof league !== 'object'
  ) {
    throw new Error(
      'League data is invalid.'
    );
  }

  const points =
    Number(
      league.Points || 0
    );

  if (
    !Number.isFinite(
      points
    ) ||
    points <= 0
  ) {
    throw new Error(
      `Could not read ${LEAGUE_NAME} points.`
    );
  }

  const contributors =
    getContributors(
      league
    );

  const state =
    loadState();

  const now =
    new Date().toISOString();

  const history =
    trimHistory([
      ...state.history,

      makeSnapshot(
        league,
        contributors
      ),
    ]);

  currentRank = rank;

  console.log(
    `${LEAGUE_NAME}: rank ${formatRank(
      rank
    )} | ${formatNumber(
      points
    )} points`
  );

  console.log(
    `Members: ${contributors
      .map(
        member =>
          `${member.name}=${formatCompact(
            member.points
          )}`
      )
      .join(', ')}`
  );

  const firstRun =
    state.rank === null ||
    !Number.isFinite(
      Number(
        state.rank
      )
    ) ||
    !Array.isArray(
      state.ranking
    );

  if (
    !firstRun &&
    Number(
      state.rank
    ) !== rank
  ) {
    const movedLeagues =
      getPassedLeagues(
        Number(
          state.rank
        ),
        rank,
        state.ranking,
        ranking
      );

    await sendRankChange(
      Number(
        state.rank
      ),
      rank,
      points,
      movedLeagues
    );

    console.log(
      `Rank changed: ${formatRank(
        state.rank
      )} -> ${formatRank(
        rank
      )}`
    );
  }

  /*
    Keep one dashboard message.
    Every successful GitHub Actions run updates
    the same Discord message.
  */

  const dashboardMessageId =
    await sendLeagueCard(
      league,
      contributors,
      history,
      state.dashboardMessageId
    );

  saveState({
    rank,
    points,
    lastCheck: now,
    ranking,
    history,
    dashboardMessageId,
  });
}

/* =========================================================
   DISCORD READY
========================================================= */

client.once(
  'ready',
  async () => {
    console.log(
      '===================================='
    );

    console.log(
      'MGKK Discord Bot'
    );

    console.log(
      '===================================='
    );

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

    console.log(
      '===================================='
    );

    try {
      await checkRank();
    } catch (error) {
      console.error(
        `[CHECK ERROR] ${
          error?.message ||
          error
        }`
      );

      process.exitCode = 1;
    } finally {
      await client.destroy();
    }
  }
);

/* =========================================================
   ERROR HANDLERS
========================================================= */

client.on(
  'error',
  error => {
    console.error(
      `[DISCORD ERROR] ${error.message}`
    );
  }
);

process.on(
  'unhandledRejection',
  error => {
    console.error(
      '[UNHANDLED REJECTION]',
      error
    );

    process.exitCode = 1;
  }
);

process.on(
  'uncaughtException',
  error => {
    console.error(
      '[UNCAUGHT EXCEPTION]',
      error
    );

    process.exitCode = 1;
  }
);

/* =========================================================
   LOGIN
========================================================= */

client
  .login(TOKEN)
  .catch(error => {
    console.error(
      `[LOGIN ERROR] ${error.message}`
    );

    process.exit(1);
  });
