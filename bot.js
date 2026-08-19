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
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('Missing DISCORD_CHANNEL_ID');
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
    ranking: [],
    history: [],
    dashboardMessageId: null,
    lastCheck: null,
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return defaultState();
    }

    const parsed = JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8')
    );

    return {
      ...defaultState(),
      ...parsed,
      ranking: Array.isArray(parsed.ranking)
        ? parsed.ranking
        : [],
      history: Array.isArray(parsed.history)
        ? parsed.history
        : [],
    };
  } catch (error) {
    console.error(
      `[STATE] ${error.message}`
    );

    return defaultState();
  }
}

function saveState(state) {
  const temp = `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    temp,
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );

  fs.renameSync(temp, STATE_FILE);
}

/* =========================================================
   BIG GAMES API
========================================================= */

async function api(endpoint) {
  const response = await fetch(
    `${API_BASE}${endpoint}`,
    {
      headers: {
        accept: 'application/json',
        'user-agent: 'MGKK-Discord-Bot/7.0',
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
      `Invalid API response: ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      json?.error?.message ||
        json?.message ||
        `API error ${response.status}`
    );
  }

  if (json?.status === 'error') {
    throw new Error(
      json?.error?.message ||
        'BIG Games API error'
    );
  }

  return json;
}

async function getLeague() {
  const result = await api(
    `/leagues/${encodeURIComponent(
      LEAGUE_NAME
    )}`
  );

  return result?.data ?? result;
}

async function getLeagueRanking() {
  const pageSize = 100;
  const ranking = [];

  for (let page = 1; page <= 10000; page++) {
    const result = await api(
      `/leagues/?page=${page}&pageSize=${pageSize}&sort=Points&sortOrder=desc`
    );

    const leagues = result?.data?.leagues;

    if (!Array.isArray(leagues)) {
      throw new Error(
        'Invalid league ranking response'
      );
    }

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

  const index = ranking.findIndex(
    name =>
      name.toLowerCase() ===
      LEAGUE_NAME.toLowerCase()
  );

  if (index === -1) {
    throw new Error(
      `${LEAGUE_NAME} was not found in leaderboard`
    );
  }

  return {
    rank: index + 1,
    ranking,
  };
}

/* =========================================================
   ROBLOX USER LOOKUP
========================================================= */

async function getRobloxUsers(userIds) {
  const uniqueIds = [
    ...new Set(
      userIds
        .map(id => Number(id))
        .filter(
          id =>
            Number.isInteger(id) &&
            id > 0
        )
    ),
  ];

  const users = new Map();

  for (
    let i = 0;
    i < uniqueIds.length;
    i += 50
  ) {
    const batch = uniqueIds.slice(
      i,
      i + 50
    );

    try {
      const response = await fetch(
        'https://users.roblox.com/v1/users',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
            accept:
              'application/json',
          },
          body: JSON.stringify({
            userIds: batch,
            excludeBannedUsers: false,
          }),
          signal:
            AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        console.warn(
          `[ROBLOX] User lookup failed: ${response.status}`
        );
        continue;
      }

      const json =
        await response.json();

      for (const user of json?.data || []) {
        users.set(
          String(user.id),
          {
            username:
              user.name ||
              String(user.id),

            displayName:
              user.displayName ||
              user.name ||
              String(user.id),
          }
        );
      }
    } catch (error) {
      console.warn(
        `[ROBLOX] ${error.message}`
      );
    }
  }

  return users;
}

/* =========================================================
   CONTRIBUTORS
========================================================= */

async function getContributors(
  league
) {
  const pointContributions =
    Array.isArray(
      league?.PointContributions
    )
      ? league.PointContributions
      : [];

  const owner =
    league?.Owner &&
    league.Owner.UserID != null
      ? league.Owner
      : null;

  const members =
    Array.isArray(league?.Members)
      ? league.Members
      : [];

  /*
   * Roster = Owner + Members
   */
  const roster = new Map();

  if (owner) {
    roster.set(
      String(owner.UserID),
      {
        userId: owner.UserID,
        name:
          owner.DisplayName ||
          owner.Username ||
          null,
      }
    );
  }

  for (const member of members) {
    if (member?.UserID == null) {
      continue;
    }

    roster.set(
      String(member.UserID),
      {
        userId: member.UserID,
        name:
          member.DisplayName ||
          member.Username ||
          null,
      }
    );
  }

  /*
   * PointContributions = authoritative points.
   */
  const contributionMap = new Map();

  for (const contribution of pointContributions) {
    if (contribution?.UserID == null) {
      continue;
    }

    contributionMap.set(
      String(contribution.UserID),
      {
        userId:
          contribution.UserID,

        points:
          Number(
            contribution.Points || 0
          ),

        timestamp:
          Number(
            contribution.Timestamp || 0
          ),

        name:
          contribution.DisplayName ||
          contribution.Username ||
          null,
      }
    );
  }

  /*
   * Make sure all roster members exist,
   * even if they have 0 contribution.
   */
  const contributors = [];

  for (const [id, member] of roster) {
    const contribution =
      contributionMap.get(id);

    contributors.push({
      userId:
        member.userId,

      name:
        contribution?.name ||
        member.name ||
        null,

      points:
        Number(
          contribution?.points || 0
        ),

      timestamp:
        Number(
          contribution?.timestamp || 0
        ),
    });
  }

  /*
   * Resolve missing numeric names through Roblox.
   */
  const missingIds =
    contributors
      .filter(
        member =>
          !member.name ||
          /^\d+$/.test(
            String(member.name)
          )
      )
      .map(
        member => member.userId
      );

  const robloxUsers =
    await getRobloxUsers(
      missingIds
    );

  for (const member of contributors) {
    const user =
      robloxUsers.get(
        String(member.userId)
      );

    if (user) {
      member.name =
        user.displayName ||
        user.username;
    }

    if (!member.name) {
      member.name =
        `User ${member.userId}`;
    }
  }

  contributors.sort(
    (a, b) =>
      b.points - a.points
  );

  return contributors;
}

/* =========================================================
   FORMATTERS
========================================================= */

function formatNumber(value) {
  return Number(
    value || 0
  ).toLocaleString('en-US');
}

function formatCompact(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) {
    return '0';
  }

  if (Math.abs(n) >= 1e9) {
    return `${(
      n / 1e9
    ).toFixed(2)}b`;
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

function formatRank(rank) {
  return `#${formatNumber(rank)}`;
}

function formatDelta(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '—';
  }

  const n = Number(value);

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

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&apos;'
    );
}

function shorten(value, max) {
  const text =
    String(value ?? '');

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(
    0,
    max - 1
  )}…`;
}

/* =========================================================
   HISTORY
========================================================= */

function createSnapshot(
  league,
  contributors
) {
  return {
    timestamp:
      Date.now(),

    points:
      Number(
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
    72 * 60 * 60 * 1000;

  return history
    .filter(
      item =>
        Number(
          item.timestamp
        ) >= cutoff
    )
    .slice(-1000);
}

function getMemberDelta(
  history,
  userId,
  hoursAgo
) {
  if (!history.length) {
    return null;
  }

  const current =
    history[
      history.length - 1
    ];

  const currentMember =
    current.members?.find(
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
    hoursAgo *
      60 *
      60 *
      1000;

  let best = null;
  let bestDistance =
    Infinity;

  for (const snapshot of history) {
    const timestamp =
      Number(
        snapshot.timestamp
      );

    if (
      timestamp > target
    ) {
      continue;
    }

    const distance =
      Math.abs(
        timestamp - target
      );

    if (
      distance <
      bestDistance
    ) {
      best = snapshot;
      bestDistance =
        distance;
    }
  }

  if (!best) {
    return null;
  }

  const oldMember =
    best.members?.find(
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
   ROBLOX AVATAR
========================================================= */

async function getAvatar(
  userId
) {
  try {
    /*
     * IMPORTANT:
     * thumbnails endpoint returns JSON.
     * We first read imageUrl, then download
     * the actual PNG.
     */
    const response = await fetch(
      'https://thumbnails.roblox.com/v1/users/avatar-headshot' +
        `?userIds=${encodeURIComponent(
          userId
        )}` +
        '&size=150x150' +
        '&format=Png' +
        '&isCircular=true',
      {
        headers: {
          accept:
            'application/json',
        },
        signal:
          AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      return null;
    }

    const json =
      await response.json();

    const imageUrl =
      json?.data?.[0]?.imageUrl;

    if (!imageUrl) {
      return null;
    }

    const imageResponse =
      await fetch(
        imageUrl,
        {
          signal:
            AbortSignal.timeout(10000),
        }
      );

    if (!imageResponse.ok) {
      return null;
    }

    const buffer =
      Buffer.from(
        await imageResponse.arrayBuffer()
      );

    return await sharp(buffer)
      .resize(64, 64, {
        fit: 'cover',
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

/* =========================================================
   LEAGUE ICON
========================================================= */

async function getLeagueIcon(
  icon
) {
  const match =
    String(icon || '').match(
      /rbxassetid:\/\/(\d+)/i
    );

  if (!match) {
    return null;
  }

  try {
    const response =
      await fetch(
        'https://thumbnails.roblox.com/v1/assets' +
          `?assetIds=${match[1]}` +
          '&returnPolicy=PlaceHolder' +
          '&size=420x420' +
          '&format=Png' +
          '&isCircular=false',
        {
          headers: {
            accept:
              'application/json',
          },
          signal:
            AbortSignal.timeout(10000),
        }
      );

    if (!response.ok) {
      return null;
    }

    const json =
      await response.json();

    const imageUrl =
      json?.data?.[0]?.imageUrl;

    if (!imageUrl) {
      return null;
    }

    const image =
      await fetch(
        imageUrl,
        {
          signal:
            AbortSignal.timeout(10000),
        }
      );

    if (!image.ok) {
      return null;
    }

    return Buffer.from(
      await image.arrayBuffer()
    );
  } catch {
    return null;
  }
}

/* =========================================================
   DASHBOARD IMAGE
   NO NESTED SVG
========================================================= */

async function makeLeagueCard(
  league,
  contributors,
  history,
  rank
) {
  const width = 1400;

  const headerHeight = 205;
  const rowHeight = 82;
  const tableHeaderHeight = 50;
  const gap = 25;

  const chartHeight = 400;

  const tableHeight =
    tableHeaderHeight +
    contributors.length *
      rowHeight;

  const chartTop =
    headerHeight +
    tableHeight +
    gap;

  const height =
    chartTop +
    chartHeight +
    30;

  const colors = [
    '#14c7ff',
    '#ff3baa',
    '#ffae1a',
    '#39dfaa',
  ];

  const avatars =
    await Promise.all(
      contributors.map(
        member =>
          getAvatar(
            member.userId
          )
      )
    );

  /*
   * Chart is drawn DIRECTLY inside this SVG.
   * No SVG inside SVG.
   */

  const chartLeft = 85;
  const chartRight = 40;
  const chartTopInner =
    chartTop + 45;
  const chartBottom =
    chartTop + chartHeight - 45;

  const chartWidth =
    width -
    chartLeft -
    chartRight;

  const chartUsableHeight =
    chartBottom -
    chartTopInner;

  const snapshots =
    history.slice(-25);

  const maxValue =
    Math.max(
      1,
      ...snapshots.flatMap(
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
      )
    );

  const yMax =
    Math.ceil(
      maxValue /
        500000
    ) *
      500000 ||
    maxValue;

  function chartX(index) {
    if (snapshots.length <= 1) {
      return (
        chartLeft +
        chartWidth / 2
      );
    }

    return (
      chartLeft +
      (index /
        (snapshots.length -
          1)) *
        chartWidth
    );
  }

  function chartY(value) {
    return (
      chartBottom -
      (Number(value || 0) /
        yMax) *
        chartUsableHeight
    );
  }

  const grid = [];

  for (
    let i = 0;
    i <= 5;
    i++
  ) {
    const value =
      (yMax / 5) * i;

    const y =
      chartY(value);

    grid.push(`
      <line
        x1="${chartLeft}"
        y1="${y}"
        x2="${chartLeft + chartWidth}"
        y2="${y}"
        stroke="#303238"
        stroke-width="1"
      />

      <text
        x="${chartLeft - 12}"
        y="${y + 5}"
        text-anchor="end"
        fill="#858891"
        font-size="15"
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

  const chartSeries =
    contributors
      .map(
        (member, seriesIndex) => {
          const color =
            colors[
              seriesIndex %
                colors.length
            ];

          const values =
            snapshots.map(
              snapshot => {
                const found =
                  snapshot.members?.find(
                    item =>
                      String(
                        item.userId
                      ) ===
                      String(
                        member.userId
                      )
                  );

                return Number(
                  found?.points || 0
                );
              }
            );

          if (!values.length) {
            return '';
          }

          const linePoints =
            values
              .map(
                (
                  value,
                  index
                ) =>
                  `${chartX(
                    index
                  )},${chartY(
                    value
                  )}`
              )
              .join(' ');

          const areaPoints =
            `${chartX(0)},${chartBottom} ` +
            linePoints +
            ` ${chartX(
              values.length - 1
            )},${chartBottom}`;

          const dots =
            values
              .map(
                (
                  value,
                  index
                ) =>
                  `
                  <circle
                    cx="${chartX(
                      index
                    )}"
                    cy="${chartY(
                      value
                    )}"
                    r="4"
                    fill="${color}"
                  />
                  `
              )
              .join('');

          return `
            <polygon
              points="${areaPoints}"
              fill="${color}"
              opacity="0.08"
            />

            <polyline
              points="${linePoints}"
              fill="none"
              stroke="${color}"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />

            ${dots}
          `;
        }
      )
      .join('');

  const chartLabels =
    snapshots
      .map(
        (snapshot, index) => {
          if (
            snapshots.length >
              12 &&
            index % 2 !== 0
          ) {
            return '';
          }

          const hours =
            Math.round(
              (Date.now() -
                Number(
                  snapshot.timestamp
                )) /
                3600000
            );

          const label =
            hours <= 0
              ? 'Now'
              : `${hours}h`;

          return `
            <text
              x="${chartX(index)}"
              y="${chartBottom + 30}"
              text-anchor="middle"
              fill="#858891"
              font-size="13"
              font-family="Arial"
            >
              ${label}
            </text>
          `;
        }
      )
      .join('');

  /* =======================================================
     HEADER
  ======================================================= */

  const leaguePoints =
    Number(
      league.Points || 0
    );

  const level =
    Number(
      league.Level || 1
    );

  const owner =
    league.Owner?.DisplayName ||
    league.Owner?.Username ||
    'Unknown';

  const capacity =
    Number(
      league.MemberCapacity ||
        contributors.length ||
        4
    );

  /* =======================================================
     TABLE
  ======================================================= */

  const tableStart =
    headerHeight;

  const tableHeaderY =
    tableStart + 31;

  const rowStart =
    tableStart +
    tableHeaderHeight;

  const tableHeaders = `
    <text
      x="35"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      #
    </text>

    <text
      x="115"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      PLAYER
    </text>

    <text
      x="650"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      POINTS
    </text>

    <text
      x="810"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      +1H
    </text>

    <text
      x="920"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      +24H
    </text>

    <text
      x="1050"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      LAST
    </text>

    <text
      x="1205"
      y="${tableHeaderY}"
      fill="#8f9199"
      font-size="15"
      font-weight="700"
      font-family="Arial"
    >
      SHARE
    </text>
  `;

  const rows =
    contributors
      .map(
        (member, index) => {
          const y =
            rowStart +
            index * rowHeight;

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
            leaguePoints > 0
              ? (member.points /
                  leaguePoints) *
                100
              : 0;

          const avatar =
            avatars[index];

          const avatarSvg =
            avatar
              ? `
                <image
                  href="data:image/png;base64,${avatar.toString(
                    'base64'
                  )}"
                  x="48"
                  y="${y + 9}"
                  width="62"
                  height="62"
                />
              `
              : `
                <circle
                  cx="79"
                  cy="${y + 40}"
                  r="31"
                  fill="#373940"
                />
              `;

          return `
            <rect
              x="20"
              y="${y}"
              width="${width - 40}"
              height="${rowHeight - 4}"
              rx="10"
              fill="#202428"
            />

            <rect
              x="20"
              y="${y}"
              width="5"
              height="${rowHeight - 4}"
              rx="2"
              fill="${color}"
            />

            <text
              x="35"
              y="${y + 48}"
              fill="${color}"
              font-size="20"
              font-weight="700"
              font-family="Arial"
            >
              ${index + 1}
            </text>

            ${avatarSvg}

            <text
              x="125"
              y="${y + 48}"
              fill="#f1f2f4"
              font-size="21"
              font-weight="700"
              font-family="Arial"
            >
              ${xmlEscape(
                shorten(
                  member.name,
                  28
                )
              )}
            </text>

            <text
              x="650"
              y="${y + 48}"
              fill="${color}"
              font-size="21"
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
              x="810"
              y="${y + 48}"
              fill="#f1f2f4"
              font-size="20"
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
              x="920"
              y="${y + 48}"
              fill="#f1f2f4"
              font-size="20"
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
              x="1050"
              y="${y + 48}"
              fill="#dfe0e4"
              font-size="20"
              font-weight="700"
              font-family="Arial"
            >
              ${member.timestamp
                ? new Date(
                    member.timestamp *
                      1000
                  ).toLocaleTimeString(
                    'en-GB',
                    {
                      hour: '2-digit',
                      minute:
                        '2-digit',
                    }
                  )
                : '—'}
            </text>

            <text
              x="1205"
              y="${y + 48}"
              fill="${color}"
              font-size="20"
              font-weight="700"
              font-family="Arial"
            >
              ${share.toFixed(
                1
              )}%
            </text>
          `;
        }
      )
      .join('');

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

      <rect
        width="${width}"
        height="${height}"
        rx="22"
        fill="#1b1d20"
      />

      <rect
        x="10"
        y="10"
        width="${width - 20}"
        height="${height - 20}"
        rx="22"
        fill="#24272b"
      />

      <!-- HEADER -->

      <text
        x="45"
        y="58"
        fill="#f2f3f5"
        font-size="34"
        font-weight="800"
        font-family="Arial"
      >
        ${xmlEscape(
          league.Name ||
            LEAGUE_NAME
        )}
      </text>

      <text
        x="45"
        y="101"
        fill="#cfd1d6"
        font-size="20"
        font-family="Arial"
      >
        Global Rank
      </text>

      <text
        x="45"
        y="137"
        fill="#ffffff"
        font-size="28"
        font-weight="800"
        font-family="Arial"
      >
        ${formatRank(rank)}
      </text>

      <text
        x="255"
        y="101"
        fill="#cfd1d6"
        font-size="20"
        font-family="Arial"
      >
        League Points
      </text>

      <text
        x="255"
        y="137"
        fill="#ffffff"
        font-size="28"
        font-weight="800"
        font-family="Arial"
      >
        ${formatNumber(
          leaguePoints
        )}
      </text>

      <text
        x="520"
        y="101"
        fill="#cfd1d6"
        font-size="20"
        font-family="Arial"
      >
        Level
      </text>

      <text
        x="520"
        y="137"
        fill="#ffffff"
        font-size="28"
        font-weight="800"
        font-family="Arial"
      >
        ${level}
      </text>

      <text
        x="690"
        y="101"
        fill="#cfd1d6"
        font-size="20"
        font-family="Arial"
      >
        Members
      </text>

      <text
        x="690"
        y="137"
        fill="#ffffff"
        font-size="28"
        font-weight="800"
        font-family="Arial"
      >
        ${contributors.length}/${capacity}
      </text>

      <text
        x="900"
        y="101"
        fill="#cfd1d6"
        font-size="20"
        font-family="Arial"
      >
        Owner
      </text>

      <text
        x="900"
        y="137"
        fill="#ffffff"
        font-size="22"
        font-weight="700"
        font-family="Arial"
      >
        ${xmlEscape(
          shorten(owner, 24)
        )}
      </text>

      <line
        x1="35"
        y1="165"
        x2="${width - 35}"
        y2="165"
        stroke="#3b3d42"
        stroke-width="1"
      />

      <!-- TABLE -->

      ${tableHeaders}

      ${rows}

      <!-- CHART -->

      <text
        x="45"
        y="${chartTop + 25}"
        fill="#f0f1f4"
        font-size="20"
        font-weight="700"
        font-family="Arial"
      >
        Contribution History
      </text>

      ${grid.join('')}

      ${chartSeries}

      ${chartLabels}

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
   RANK CHANGE
========================================================= */

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

function createRankEmbed(
  oldRank,
  newRank,
  points,
  movedLeagues
) {
  const increased =
    newRank < oldRank;

  const amount =
    Math.abs(
      oldRank - newRank
    );

  const embed =
    new EmbedBuilder()
      .setTitle(
        increased
          ? `📈 ${LEAGUE_NAME} — Increased!`
          : `📉 ${LEAGUE_NAME} — Decreased!`
      )
      .setDescription(
        increased
          ? `**${LEAGUE_NAME}** increased **${amount} ${
              amount === 1
                ? 'position'
                : 'positions'
            }** in the League Leaderboard!`
          : `**${LEAGUE_NAME}** decreased **${amount} ${
              amount === 1
                ? 'position'
                : 'positions'
            }** in the League Leaderboard!`
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
            increased
              ? '⬆️ Overtook'
              : '⬇️ Overtaken by',
          value:
            movedLeagues.length
              ? movedLeagues
                  .slice(
                    0,
                    10
                  )
                  .map(
                    name =>
                      `• **${name}**`
                  )
                  .join('\n')
              : '• —',
          inline: false,
        }
      )
      .setFooter({
        text:
          'MGKK League • MADE BY BRAT',
      })
      .setTimestamp();

  return embed;
}

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
      'Discord channel is invalid'
    );
  }

  const payload = {
    embeds: [
      createRankEmbed(
        oldRank,
        newRank,
        points,
        movedLeagues
      ),
    ],
  };

  /*
   * IMPORTANT:
   * Logo is now a SMALL thumbnail,
   * not a giant image above the embed.
   */
  if (
    fs.existsSync(
      LOGO_FILE
    )
  ) {
    payload.files = [
      new AttachmentBuilder(
        LOGO_FILE,
        {
          name:
            'mgkk-logo.png',
        }
      ),
    ];

    payload.embeds[0].setThumbnail(
      'attachment://mgkk-logo.png'
    );
  }

  await channel.send(
    payload
  );
}

/* =========================================================
   DASHBOARD MESSAGE
========================================================= */

async function sendDashboard(
  league,
  contributors,
  history,
  rank,
  oldMessageId
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
      'Discord channel is invalid'
    );
  }

  const card =
    await makeLeagueCard(
      league,
      contributors,
      history,
      rank
    );

  const file =
    new AttachmentBuilder(
      card,
      {
        name:
          'mgkk-dashboard.png',
      }
    );

  /*
   * Try to update the same message.
   */
  if (oldMessageId) {
    try {
      const message =
        await channel.messages.fetch(
          oldMessageId
        );

      await message.edit({
        content: '',
        embeds: [],
        files: [file],
      });

      console.log(
        `[DASHBOARD] Updated ${message.id}`
      );

      return message.id;
    } catch (error) {
      console.warn(
        `[DASHBOARD] Existing message unavailable: ${error.message}`
      );
    }
  }

  /*
   * No existing message -> create exactly one.
   */
  const message =
    await channel.send({
      files: [file],
    });

  console.log(
    `[DASHBOARD] Created ${message.id}`
  );

  return message.id;
}

/* =========================================================
   MAIN CHECK
========================================================= */

async function check() {
  console.log(
    `[${new Date().toISOString()}] Checking ${LEAGUE_NAME}...`
  );

  const [
    league,
    rankingData,
  ] = await Promise.all([
    getLeague(),
    getLeagueRanking(),
  ]);

  if (
    !league ||
    typeof league !== 'object'
  ) {
    throw new Error(
      'Invalid league data'
    );
  }

  const points =
    Number(
      league.Points || 0
    );

  if (!Number.isFinite(points)) {
    throw new Error(
      'Invalid league points'
    );
  }

  const contributors =
    await getContributors(
      league
    );

  const state =
    loadState();

  const snapshot =
    createSnapshot(
      league,
      contributors
    );

  const history =
    trimHistory([
      ...state.history,
      snapshot,
    ]);

  const rank =
    rankingData.rank;

  console.log(
    `${LEAGUE_NAME} ${formatRank(
      rank
    )} | ${formatNumber(
      points
    )} points`
  );

  console.log(
    contributors
      .map(
        member =>
          `${member.name}: ${formatCompact(
            member.points
          )}`
      )
      .join(' | ')
  );

  /*
   * Rank notification.
   */
  const firstRun =
    state.rank === null ||
    !Number.isFinite(
      Number(state.rank)
    );

  if (
    !firstRun &&
    Number(state.rank) !== rank
  ) {
    const moved =
      getPassedLeagues(
        Number(state.rank),
        rank,
        state.ranking,
        rankingData.ranking
      );

    await sendRankChange(
      Number(state.rank),
      rank,
      points,
      moved
    );

    console.log(
      `[RANK] ${state.rank} -> ${rank}`
    );
  }

  /*
   * Dashboard.
   */
  const dashboardMessageId =
    await sendDashboard(
      league,
      contributors,
      history,
      rank,
      state.dashboardMessageId
    );

  saveState({
    rank,
    points,
    ranking:
      rankingData.ranking,
    history,
    dashboardMessageId,
    lastCheck:
      new Date().toISOString(),
  });

  console.log(
    '[DONE] Check completed successfully.'
  );
}

/* =========================================================
   DISCORD
========================================================= */

client.once(
  'ready',
  async () => {
    console.log(
      '================================'
    );

    console.log(
      `Logged in as ${client.user.tag}`
    );

    console.log(
      `League: ${LEAGUE_NAME}`
    );

    console.log(
      '================================'
    );

    try {
      await check();
    } catch (error) {
      console.error(
        `[CHECK ERROR] ${
          error?.stack ||
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

client.login(
  TOKEN
).catch(error => {
  console.error(
    `[LOGIN ERROR] ${error.message}`
  );

  process.exit(1);
});
