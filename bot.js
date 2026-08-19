const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  EmbedBuilder,
} = require("discord.js");

require("dotenv").config();

/* =========================================================
   CONFIG
========================================================= */

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const LEAGUE_NAME = process.env.LEAGUE_NAME || "MGKK";

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN secret.");
}

if (!DISCORD_CHANNEL_ID) {
  throw new Error("Missing DISCORD_CHANNEL_ID secret.");
}

const API_BASE = "https://ps99.biggamesapi.io";

const ROBLOX_THUMBNAILS =
  "https://thumbnails.roblox.com/v1/users/avatar-headshot";

const STATE_FILE = path.join(__dirname, "state.json");

const WIDTH = 1600;
const HEIGHT = 1080;

const COLORS = [
  "#25C2F2",
  "#F23AA5",
  "#FFAA18",
  "#3EE0B2",
];

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* =========================================================
   HTTP
========================================================= */

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let body;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Invalid JSON received from API. HTTP ${response.status}`
    );
  }

  if (!response.ok || body?.status === "error") {
    const message =
      body?.error?.message ||
      body?.error?.code ||
      `HTTP ${response.status}`;

    throw new Error(`${message} — ${url}`);
  }

  return body?.data ?? body;
}

/* =========================================================
   BIG GAMES API
========================================================= */

async function getLeague() {
  const url =
    `${API_BASE}/v1/leagues/` +
    encodeURIComponent(LEAGUE_NAME);

  return fetchJson(url);
}

async function getLeaguePage(page, pageSize = 100) {
  const url =
    `${API_BASE}/v1/leagues` +
    `?page=${page}` +
    `&pageSize=${pageSize}` +
    `&sort=Points` +
    `&sortOrder=desc`;

  return fetchJson(url);
}

/* =========================================================
   GLOBAL RANK
========================================================= */

async function getGlobalRank(targetLeague) {
  const pageSize = 100;
  const targetPoints = Number(targetLeague.Points || 0);

  const firstPage = await getLeaguePage(1, pageSize);

  const total = Number(firstPage.total || 0);

  if (!total) {
    return null;
  }

  const lastPage = Math.ceil(total / pageSize);

  /*
    We first use binary search to find approximately
    where the league belongs based on its points.
  */

  let low = 1;
  let high = lastPage;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    const page = await getLeaguePage(middle, pageSize);

    const leagues = Array.isArray(page.leagues)
      ? page.leagues
      : [];

    if (!leagues.length) {
      high = middle;
      continue;
    }

    const lastPoints = Number(
      leagues[leagues.length - 1].Points || 0
    );

    if (lastPoints > targetPoints) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  /*
    Check several pages around the estimated location.
  */

  const pagesToCheck = new Set();

  for (let offset = -3; offset <= 3; offset++) {
    const pageNumber = low + offset;

    if (
      pageNumber >= 1 &&
      pageNumber <= lastPage
    ) {
      pagesToCheck.add(pageNumber);
    }
  }

  for (const pageNumber of [...pagesToCheck].sort(
    (a, b) => a - b
  )) {
    const page =
      pageNumber === 1
        ? firstPage
        : await getLeaguePage(pageNumber, pageSize);

    const leagues = Array.isArray(page.leagues)
      ? page.leagues
      : [];

    for (let i = 0; i < leagues.length; i++) {
      const league = leagues[i];

      const sameName =
        String(league.Name || "").toLowerCase() ===
        String(targetLeague.Name || LEAGUE_NAME).toLowerCase();

      const sameId =
        targetLeague.ID &&
        league.ID &&
        String(targetLeague.ID) === String(league.ID);

      if (sameId || sameName) {
        return (
          (pageNumber - 1) * pageSize +
          i +
          1
        );
      }
    }
  }

  /*
    Very safe fallback.

    This only happens if equal point totals caused the
    binary-search window to miss the league.
  */

  console.log(
    "Rank not found in estimated pages. Starting full scan..."
  );

  for (
    let pageNumber = 1;
    pageNumber <= lastPage;
    pageNumber++
  ) {
    if (pagesToCheck.has(pageNumber)) {
      continue;
    }

    const page =
      pageNumber === 1
        ? firstPage
        : await getLeaguePage(pageNumber, pageSize);

    const leagues = Array.isArray(page.leagues)
      ? page.leagues
      : [];

    for (let i = 0; i < leagues.length; i++) {
      const league = leagues[i];

      const sameId =
        targetLeague.ID &&
        league.ID &&
        String(targetLeague.ID) === String(league.ID);

      const sameName =
        String(league.Name || "").toLowerCase() ===
        String(targetLeague.Name || LEAGUE_NAME).toLowerCase();

      if (sameId || sameName) {
        return (
          (pageNumber - 1) * pageSize +
          i +
          1
        );
      }
    }
  }

  return null;
}

/* =========================================================
   STATE
========================================================= */

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return {
        snapshots: [],
        lastRank: null,
      };
    }

    const raw = fs.readFileSync(
      STATE_FILE,
      "utf8"
    );

    const parsed = JSON.parse(raw);

    return {
      snapshots: Array.isArray(parsed.snapshots)
        ? parsed.snapshots
        : [],

      lastRank:
        Number.isFinite(Number(parsed.lastRank))
          ? Number(parsed.lastRank)
          : null,
    };
  } catch (error) {
    console.warn(
      "Could not read state.json. Creating a new state."
    );

    return {
      snapshots: [],
      lastRank: null,
    };
  }
}

function writeState(state) {
  const temporaryFile =
    `${STATE_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(state, null, 2),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    STATE_FILE
  );
}

/* =========================================================
   ROSTER
========================================================= */

function normalizeId(value) {
  return String(value ?? "");
}

function getRoster(league) {
  const roster = [];

  /*
    Owner
  */

  if (
    league.Owner &&
    league.Owner.UserID != null
  ) {
    roster.push({
      UserID: league.Owner.UserID,
      DisplayName: league.Owner.DisplayName,
    });
  }

  /*
    Members
  */

  if (Array.isArray(league.Members)) {
    for (const member of league.Members) {
      if (
        member &&
        member.UserID != null
      ) {
        roster.push({
          UserID: member.UserID,
          DisplayName: member.DisplayName,
        });
      }
    }
  }

  /*
    Remove duplicate IDs.
  */

  const seen = new Set();

  return roster.filter((player) => {
    const id = normalizeId(player.UserID);

    if (!id) {
      return false;
    }

    if (seen.has(id)) {
      return false;
    }

    seen.add(id);

    return true;
  });
}

/* =========================================================
   CONTRIBUTIONS
========================================================= */

function getContributors(league) {
  const contributions =
    Array.isArray(league.PointContributions)
      ? league.PointContributions
      : [];

  const map = new Map();

  for (const entry of contributions) {
    if (
      !entry ||
      entry.UserID == null
    ) {
      continue;
    }

    map.set(
      normalizeId(entry.UserID),
      entry
    );
  }

  return map;
}

/* =========================================================
   BUILD PLAYER DATA
========================================================= */

function buildPlayers(league) {
  const roster = getRoster(league);
  const contributions = getContributors(league);

  return roster.map((member) => {
    const id = normalizeId(member.UserID);

    const contribution =
      contributions.get(id);

    /*
      IMPORTANT:

      PointContributions.DisplayName is preferred.

      If for some reason it is missing,
      use Members/Owner DisplayName.

      Only if both are missing do we show the ID.
    */

    const displayName =
      contribution?.DisplayName ||
      member.DisplayName ||
      id;

    return {
      userId: id,

      displayName,

      points: Number(
        contribution?.Points || 0
      ),

      timestamp:
        contribution?.Timestamp == null
          ? null
          : Number(
              contribution.Timestamp
            ),
    };
  });
}

/* =========================================================
   NUMBER FORMATTING
========================================================= */

function formatNumber(value) {
  return new Intl.NumberFormat(
    "en-US"
  ).format(
    Math.round(
      Number(value) || 0
    )
  );
}

function formatCompact(value) {
  const number =
    Number(value) || 0;

  if (Math.abs(number) >= 1e9) {
    return (
      number / 1e9
    ).toFixed(2) + "b";
  }

  if (Math.abs(number) >= 1e6) {
    return (
      number / 1e6
    ).toFixed(2) + "m";
  }

  if (Math.abs(number) >= 1e3) {
    return (
      number / 1e3
    ).toFixed(2) + "k";
  }

  return formatNumber(number);
}

/* =========================================================
   SVG HELPERS
========================================================= */

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(value, max = 22) {
  const text = String(value ?? "");

  if (text.length <= max) {
    return text;
  }

  return (
    text.slice(0, max - 1) +
    "…"
  );
}

function svgText(
  text,
  x,
  y,
  size,
  weight = 400,
  fill = "#F4F7FB",
  anchor = "start"
) {
  return `
    <text
      x="${x}"
      y="${y}"
      font-family="Arial, Helvetica, sans-serif"
      font-size="${size}px"
      font-weight="${weight}"
      fill="${fill}"
      text-anchor="${anchor}"
    >${escapeXml(text)}</text>
  `;
}

function roundedRect(
  x,
  y,
  width,
  height,
  radius,
  fill,
  stroke = "none",
  strokeWidth = 0
) {
  return `
    <rect
      x="${x}"
      y="${y}"
      width="${width}"
      height="${height}"
      rx="${radius}"
      fill="${fill}"
      stroke="${stroke}"
      stroke-width="${strokeWidth}"
    />
  `;
}

/* =========================================================
   ROBLOX AVATARS
========================================================= */

async function downloadBuffer(url) {
  try {
    const response =
      await fetch(url);

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

async function getAvatars(userIds) {
  const ids = userIds
    .filter(Boolean)
    .join(",");

  if (!ids) {
    return new Map();
  }

  const url =
    `${ROBLOX_THUMBNAILS}` +
    `?userIds=${encodeURIComponent(ids)}` +
    `&size=150x150` +
    `&format=Png` +
    `&isCircular=false`;

  try {
    const data =
      await fetchJson(url);

    const map = new Map();

    const results =
      Array.isArray(data.data)
        ? data.data
        : [];

    for (const item of results) {
      if (
        !item?.targetId ||
        !item?.imageUrl
      ) {
        continue;
      }

      const image =
        await downloadBuffer(
          item.imageUrl
        );

      if (!image) {
        continue;
      }

      /*
        Embed the image directly inside
        the SVG as base64.

        This prevents Sharp/librsvg from
        needing to download the image itself.
      */

      map.set(
        String(item.targetId),
        `data:image/png;base64,${image.toString(
          "base64"
        )}`
      );
    }

    return map;
  } catch (error) {
    console.warn(
      "Roblox avatar lookup failed:",
      error.message
    );

    return new Map();
  }
}

/* =========================================================
   STATE SNAPSHOT
========================================================= */

function createSnapshot(
  players,
  timestamp
) {
  const playerData = {};

  for (const player of players) {
    playerData[player.userId] = {
      displayName:
        player.displayName,

      points:
        player.points,

      timestamp:
        player.timestamp,
    };
  }

  return {
    timestamp,
    players: playerData,
  };
}

/* =========================================================
   HISTORICAL DATA
========================================================= */

function getHistoricalPoints(
  state,
  userId,
  hours
) {
  const targetTime =
    Date.now() -
    hours *
      60 *
      60 *
      1000;

  const snapshots =
    [...state.snapshots].sort(
      (a, b) =>
        Number(a.timestamp) -
        Number(b.timestamp)
    );

  let selected = null;

  for (const snapshot of snapshots) {
    if (
      Number(snapshot.timestamp) <=
      targetTime
    ) {
      selected = snapshot;
    } else {
      break;
    }
  }

  if (
    !selected ||
    !selected.players ||
    !selected.players[userId]
  ) {
    return null;
  }

  return Number(
    selected.players[userId].points || 0
  );
}

function getHistoricalDelta(
  state,
  userId,
  currentPoints,
  hours
) {
  const oldPoints =
    getHistoricalPoints(
      state,
      userId,
      hours
    );

  if (oldPoints == null) {
    return null;
  }

  return Math.max(
    0,
    Number(currentPoints || 0) -
      oldPoints
  );
}

/* =========================================================
   CHART
========================================================= */

function makeChartSvg(
  players,
  state,
  x,
  y,
  width,
  height
) {
  const left =
    x + 70;

  const right =
    x + width - 30;

  const top =
    y + 60;

  const bottom =
    y + height - 55;

  const chartWidth =
    right - left;

  const chartHeight =
    bottom - top;

  const values =
    players.map(
      (player) =>
        Number(player.points) || 0
    );

  const maxValue =
    Math.max(
      1,
      ...values
    );

  let output = "";

  const gridLines = 4;

  /*
    Horizontal grid.
  */

  for (
    let i = 0;
    i <= gridLines;
    i++
  ) {
    const gridY =
      top +
      (chartHeight * i) /
        gridLines;

    const value =
      maxValue *
      (1 - i / gridLines);

    output += `
      <line
        x1="${left}"
        y1="${gridY}"
        x2="${right}"
        y2="${gridY}"
        stroke="#303741"
        stroke-width="1"
      />
    `;

    output += svgText(
      formatCompact(value),
      left - 12,
      gridY + 5,
      14,
      500,
      "#9AA5B5",
      "end"
    );
  }

  output += svgText(
    "24H",
    left,
    bottom + 35,
    14,
    600,
    "#8E99A8",
    "middle"
  );

  output += svgText(
    "NOW",
    right,
    bottom + 35,
    14,
    600,
    "#8E99A8",
    "middle"
  );

  /*
    One line per player.
  */

  players.forEach(
    (player, index) => {
      const color =
        COLORS[
          index % COLORS.length
        ];

      const current =
        Number(player.points) || 0;

      const oldPoints =
        getHistoricalPoints(
          state,
          player.userId,
          24
        );

      const startingValue =
        oldPoints == null
          ? 0
          : oldPoints;

      const startX =
        left;

      const startY =
        bottom -
        (startingValue /
          maxValue) *
          chartHeight;

      const endX =
        right;

      const endY =
        bottom -
        (current /
          maxValue) *
          chartHeight;

      output += `
        <line
          x1="${startX}"
          y1="${startY}"
          x2="${endX}"
          y2="${endY}"
          stroke="${color}"
          stroke-width="5"
          stroke-linecap="round"
        />

        <circle
          cx="${endX}"
          cy="${endY}"
          r="7"
          fill="${color}"
        />
      `;

      const legendX =
        left +
        index * 310;

      output += `
        <circle
          cx="${legendX}"
          cy="${y + 28}"
          r="6"
          fill="${color}"
        />
      `;

      output += svgText(
        truncate(
          player.displayName,
          24
        ),
        legendX + 15,
        y + 33,
        14,
        600,
        "#E8EDF4"
      );
    }
  );

  return output;
}

/* =========================================================
   DASHBOARD IMAGE
========================================================= */

async function renderDashboard(
  league,
  players,
  rank,
  state
) {
  const avatars =
    await getAvatars(
      players.map(
        (player) =>
          player.userId
      )
    );

  const rowsTop = 390;
  const rowHeight = 64;

  const chartY =
    rowsTop +
    rowHeight * 4 +
    18;

  const chartHeight = 260;

  let svg = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${HEIGHT}"
>

  <!-- BACKGROUND -->

  <rect
    width="${WIDTH}"
    height="${HEIGHT}"
    fill="#15181D"
  />

  <!-- HEADER -->

  ${roundedRect(
    34,
    28,
    1532,
    140,
    24,
    "#1B2128",
    "#303943",
    2
  )}

  ${svgText(
    "★",
    70,
    92,
    54,
    700,
    "#FFFFFF"
  )}

  ${svgText(
    league.Name || LEAGUE_NAME,
    132,
    82,
    38,
    700,
    "#F4F7FB"
  )}

  ${svgText(
    "League dashboard",
    72,
    124,
    20,
    500,
    "#9CA7B6"
  )}

  ${svgText(
    rank ? `#${rank}` : "#?",
    1510,
    78,
    38,
    700,
    "#FFD34E",
    "end"
  )}

  ${svgText(
    "GLOBAL RANK",
    1510,
    120,
    18,
    700,
    "#9CA7B6",
    "end"
  )}

  <!-- TOTAL POINTS -->

  ${roundedRect(
    34,
    190,
    1532,
    128,
    24,
    "#1E242A",
    "#303943",
    2
  )}

  ${svgText(
    "TOTAL LEAGUE POINTS",
    72,
    238,
    18,
    700,
    "#9CA7B6"
  )}

  ${svgText(
    formatNumber(league.Points),
    72,
    286,
    40,
    700,
    "#F4F7FB"
  )}

  ${svgText(
    `${players.length}/${
      league.MemberCapacity || 4
    } MEMBERS`,
    1510,
    236,
    18,
    700,
    "#48D5FF",
    "end"
  )}

  ${svgText(
    "Live API data",
    1510,
    282,
    16,
    500,
    "#9CA7B6",
    "end"
  )}

  <!-- PLAYER CONTRIBUTIONS TITLE -->

  ${svgText(
    "PLAYER CONTRIBUTIONS",
    52,
    372,
    20,
    700,
    "#F4F7FB"
  )}

  <!-- TABLE -->

  ${roundedRect(
    34,
    390,
    1532,
    256,
    24,
    "#1E242A",
    "#303943",
    2
  )}

  ${svgText(
    "PLAYER",
    160,
    428,
    15,
    700,
    "#9AA5B5"
  )}

  ${svgText(
    "CONTRIBUTED",
    700,
    428,
    15,
    700,
    "#9AA5B5",
    "end"
  )}

  ${svgText(
    "+1H",
    875,
    428,
    15,
    700,
    "#9AA5B5",
    "end"
  )}

  ${svgText(
    "+24H",
    1045,
    428,
    15,
    700,
    "#9AA5B5",
    "end"
  )}

  ${svgText(
    "SHARE",
    1195,
    428,
    15,
    700,
    "#9AA5B5",
    "end"
  )}

  ${svgText(
    "UPDATED",
    1450,
    428,
    15,
    700,
    "#9AA5B5",
    "end"
  )}
  `;

  /*
    Exactly 4 player rows.
  */

  for (
    let index = 0;
    index < 4;
    index++
  ) {
    const player =
      players[index] || {
        userId: "-",
        displayName: "-",
        points: 0,
        timestamp: null,
      };

    const color =
      COLORS[
        index % COLORS.length
      ];

    const y =
      rowsTop +
      48 +
      index * rowHeight;

    const oneHour =
      getHistoricalDelta(
        state,
        player.userId,
        player.points,
        1
      );

    const twentyFourHours =
      getHistoricalDelta(
        state,
        player.userId,
        player.points,
        24
      );

    const share =
      Number(league.Points) > 0
        ? (
            Number(player.points) /
            Number(league.Points)
          ) * 100
        : 0;

    /*
      Color marker.
    */

    svg += `
      <rect
        x="49"
        y="${y - 30}"
        width="6"
        height="40"
        rx="3"
        fill="${color}"
      />
    `;

    /*
      Avatar background.
    */

    svg += roundedRect(
      78,
      y - 30,
      46,
      46,
      23,
      "#39414A"
    );

    /*
      Avatar.
    */

    const avatar =
      avatars.get(
        String(player.userId)
      );

    if (avatar) {
      svg += `
        <defs>
          <clipPath id="avatar-${index}">
            <circle
              cx="101"
              cy="${y - 7}"
              r="21"
            />
          </clipPath>
        </defs>

        <image
          href="${avatar}"
          x="80"
          y="${y - 28}"
          width="42"
          height="42"
          preserveAspectRatio="xMidYMid slice"
          clip-path="url(#avatar-${index})"
        />
      `;
    }

    /*
      DISPLAY NAME
    */

    svg += svgText(
      truncate(
        player.displayName,
        24
      ),
      160,
      y - 5,
      21,
      700,
      "#F2F5F9"
    );

    /*
      USER ID
    */

    svg += svgText(
      `ID ${player.userId}`,
      160,
      y + 18,
      13,
      500,
      "#7F8B9A"
    );

    /*
      CONTRIBUTED
    */

    svg += svgText(
      `★ ${formatCompact(
        player.points
      )}`,
      700,
      y + 3,
      21,
      700,
      color,
      "end"
    );

    /*
      +1H
    */

    svg += svgText(
      oneHour == null
        ? "—"
        : `+${formatCompact(
            oneHour
          )}`,
      875,
      y + 3,
      18,
      600,
      oneHour == null
        ? "#8B96A4"
        : "#DCE3EB",
      "end"
    );

    /*
      +24H
    */

    svg += svgText(
      twentyFourHours == null
        ? "—"
        : `+${formatCompact(
            twentyFourHours
          )}`,
      1045,
      y + 3,
      18,
      600,
      twentyFourHours == null
        ? "#8B96A4"
        : "#DCE3EB",
      "end"
    );

    /*
      SHARE
    */

    svg += svgText(
      `${share.toFixed(1)}%`,
      1195,
      y + 3,
      18,
      700,
      color,
      "end"
    );

    /*
      LAST UPDATE
    */

    const updated =
      player.timestamp
        ? new Date(
            Number(
              player.timestamp
            ) * 1000
          ).toLocaleTimeString(
            "en-US",
            {
              hour: "2-digit",
              minute: "2-digit",
            }
          )
        : "—";

    svg += svgText(
      updated,
      1450,
      y + 3,
      17,
      600,
      "#9AA5B5",
      "end"
    );

    /*
      Separator.
    */

    if (index < 3) {
      svg += `
        <line
          x1="160"
          y1="${y + 34}"
          x2="1450"
          y2="${y + 34}"
          stroke="#2B323A"
          stroke-width="1"
        />
      `;
    }
  }

  /*
    CHART
  */

  svg += `
    ${svgText(
      "CONTRIBUTION HISTORY — LAST 24H",
      52,
      chartY - 12,
      20,
      700,
      "#F4F7FB"
    )}

    ${roundedRect(
      34,
      chartY,
      1532,
      chartHeight,
      24,
      "#1E242A",
      "#303943",
      2
    )}

    ${makeChartSvg(
      players,
      state,
      34,
      chartY,
      1532,
      chartHeight
    )}

    ${svgText(
      "MGKK • BIG Games API",
      1535,
      1042,
      14,
      500,
      "#8994A2",
      "end"
    )}

</svg>
`;

  return sharp(
    Buffer.from(svg)
  )
    .png()
    .toBuffer();
}

/* =========================================================
   RANK CHANGE
========================================================= */

function getRankChange(
  previousRank,
  currentRank
) {
  if (
    previousRank == null ||
    currentRank == null ||
    previousRank === currentRank
  ) {
    return null;
  }

  const difference =
    previousRank -
    currentRank;

  if (difference > 0) {
    return {
      type: "up",
      positions: difference,
    };
  }

  if (difference < 0) {
    return {
      type: "down",
      positions: Math.abs(
        difference
      ),
    };
  }

  return null;
}

/* =========================================================
   DISCORD RANK MESSAGE
========================================================= */

async function sendRankMessage(
  channel,
  league,
  rank,
  previousRank
) {
  const change =
    getRankChange(
      previousRank,
      rank
    );

  if (!change) {
    return;
  }

  const increased =
    change.type === "up";

  const title =
    increased
      ? `📈 ${league.Name} — Increased!`
      : `📉 ${league.Name} — Decreased!`;

  const description =
    increased
      ? `**${league.Name}** increased **${change.positions} position${
          change.positions === 1
            ? ""
            : "s"
        }** in the League Leaderboard!`
      : `**${league.Name}** decreased **${change.positions} position${
          change.positions === 1
            ? ""
            : "s"
        }** in the League Leaderboard!`;

  const embed =
    new EmbedBuilder()
      .setTitle(title)
      .setDescription(
        description
      )
      .addFields(
        {
          name:
            "↩️ Previous place",
          value:
            `#${previousRank}`,
          inline: true,
        },
        {
          name:
            "🏆 Current place",
          value:
            `#${rank}`,
          inline: true,
        },
        {
          name:
            "💎 Points",
          value:
            formatNumber(
              league.Points
            ),
          inline: true,
        }
      )
      .setFooter({
        text:
          `${league.Name} League • BIG Games API`,
      })
      .setTimestamp();

  await channel.send({
    embeds: [embed],
  });
}

/* =========================================================
   MAIN
========================================================= */

async function main() {
  console.log(
    `Checking league: ${LEAGUE_NAME}`
  );

  /*
    Get live league data.
  */

  const league =
    await getLeague();

  /*
    Build the four players from:
      Owner + Members
    and match them against:
      PointContributions
  */

  const players =
    buildPlayers(league);

  console.log(
    `League: ${league.Name}`
  );

  console.log(
    `Points: ${formatNumber(
      league.Points
    )}`
  );

  console.log(
    `Members: ${players.length}/${
      league.MemberCapacity || 4
    }`
  );

  for (const player of players) {
    console.log(
      ` - ${player.displayName} (${player.userId}) = ${formatNumber(
        player.points
      )}`
    );
  }

  /*
    Get exact global rank.
  */

  const rank =
    await getGlobalRank(
      league
    );

  console.log(
    `Global rank: ${
      rank ?? "not found"
    }`
  );

  /*
    Read previous state.
  */

  const state =
    readState();

  const previousRank =
    state.lastRank;

  /*
    Add current snapshot.
  */

  const now =
    Date.now();

  state.snapshots.push(
    createSnapshot(
      players,
      now
    )
  );

  /*
    Keep 3 days.
  */

  const keepAfter =
    now -
    3 *
      24 *
      60 *
      60 *
      1000;

  state.snapshots =
    state.snapshots.filter(
      (snapshot) =>
        Number(
          snapshot.timestamp
        ) >= keepAfter
    );

  /*
    Save rank.
  */

  if (rank != null) {
    state.lastRank = rank;
  }

  /*
    Save state before Discord.
  */

  writeState(state);

  /*
    Login Discord.
  */

  await client.login(
    DISCORD_TOKEN
  );

  /*
    Get channel.
  */

  const channel =
    await client.channels.fetch(
      DISCORD_CHANNEL_ID
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      "DISCORD_CHANNEL_ID is not a text-based Discord channel."
    );
  }

  /*
    Rank-change message only
    when rank actually changed.
  */

  if (
    rank != null &&
    previousRank != null
  ) {
    await sendRankMessage(
      channel,
      league,
      rank,
      previousRank
    );
  }

  /*
    Generate dashboard.
  */

  console.log(
    "Generating dashboard..."
  );

  const png =
    await renderDashboard(
      league,
      players,
      rank,
      state
    );

  /*
    Send ONE dashboard image.
  */

  await channel.send({
    files: [
      new AttachmentBuilder(
        png,
        {
          name:
            "mgkk-dashboard.png",

          description:
            `${league.Name} league dashboard`,
        }
      ),
    ],
  });

  console.log(
    "Dashboard sent successfully."
  );

  await client.destroy();
}

/* =========================================================
   ERROR HANDLER
========================================================= */

main().catch((error) => {
  console.error(
    "========================================"
  );

  console.error(
    "MGKK BOT ERROR"
  );

  console.error(
    "========================================"
  );

  console.error(
    error?.stack || error
  );

  process.exitCode = 1;
});
