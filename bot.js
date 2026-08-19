const fs = require("fs");
const path = require("path");
const https = require("https");
const sharp = require("sharp");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} = require("discord.js");

require("dotenv").config();

const API_BASE = "https://ps99.biggamesapi.io/v1";
const LEAGUE_NAME = process.env.LEAGUE_NAME || "MGKK";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const STATE_FILE = path.join(process.cwd(), "state.json");

const SNAPSHOT_INTERVAL = 5 * 60 * 1000;
const HISTORY_RETENTION = 7 * 24 * 60 * 60 * 1000;

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing.");
}

if (!DISCORD_CHANNEL_ID) {
  throw new Error("DISCORD_CHANNEL_ID is missing.");
}

/* =========================================================
   HELPERS
========================================================= */

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      leagueName: LEAGUE_NAME,
      snapshots: [],
      previousRank: null,
      dashboardMessageId: null,
    };
  }

  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    return {
      leagueName: LEAGUE_NAME,
      snapshots: Array.isArray(state.snapshots)
        ? state.snapshots
        : [],
      previousRank:
        Number.isFinite(state.previousRank)
          ? state.previousRank
          : null,
      dashboardMessageId:
        typeof state.dashboardMessageId === "string"
          ? state.dashboardMessageId
          : null,
    };
  } catch {
    console.warn("state.json is invalid. Starting fresh.");

    return {
      leagueName: LEAGUE_NAME,
      snapshots: [],
      previousRank: null,
      dashboardMessageId: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

function formatPoints(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  const abs = Math.abs(value);

  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}b`;
  }

  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}m`;
  }

  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(2)}k`;
  }

  return Math.round(value).toLocaleString("en-US");
}

function formatFullPoints(value) {
  return Math.round(value || 0).toLocaleString("en-US");
}

function formatDelta(value) {
  if (value === null || value === undefined) {
    return "—";
  }

  if (!Number.isFinite(value)) {
    return "—";
  }

  if (value === 0) {
    return "0";
  }

  return `${value > 0 ? "+" : ""}${formatPoints(value)}`;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/* =========================================================
   HTTP
========================================================= */

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "MGKK-Discord-Bot/2.0",
        },
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          let parsed;

          try {
            parsed = JSON.parse(body);
          } catch {
            reject(
              new Error(
                `Invalid JSON from API (${response.statusCode}).`
              )
            );
            return;
          }

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            const message =
              parsed?.error?.message ||
              `HTTP ${response.statusCode}`;

            reject(new Error(message));
            return;
          }

          if (parsed?.status === "error") {
            reject(
              new Error(
                parsed?.error?.message ||
                  "API returned an error."
              )
            );
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.setTimeout(20_000, () => {
      request.destroy(
        new Error("API request timed out.")
      );
    });

    request.on("error", reject);
  });
}

async function getLeague() {
  const url =
    `${API_BASE}/leagues/` +
    encodeURIComponent(LEAGUE_NAME);

  const response = await getJson(url);

  if (!response?.data) {
    throw new Error("League API returned no data.");
  }

  return response.data;
}

/* =========================================================
   LEAGUE RANK
========================================================= */

/*
  The league detail endpoint gives us the league itself,
  but not its global rank.

  We therefore inspect leaderboard pages around the previous
  rank and expand outward when necessary.

  Page size = 100, which is the API maximum.
*/

async function getLeagueRank(points, previousRank) {
  const PAGE_SIZE = 100;

  let center;

  if (
    Number.isFinite(previousRank) &&
    previousRank > 0
  ) {
    center = Math.max(
      1,
      Math.floor((previousRank - 1) / PAGE_SIZE) + 1
    );
  } else {
    center = 1;
  }

  const checkedPages = new Set();

  async function checkPage(page) {
    if (checkedPages.has(page)) {
      return null;
    }

    checkedPages.add(page);

    const url =
      `${API_BASE}/leagues` +
      `?page=${page}` +
      `&pageSize=${PAGE_SIZE}` +
      `&sort=Points` +
      `&sortOrder=desc`;

    const response = await getJson(url);

    const leagues =
      response?.data?.leagues || [];

    for (let index = 0; index < leagues.length; index++) {
      const league = leagues[index];

      if (
        String(league.Name).toLowerCase() ===
        LEAGUE_NAME.toLowerCase()
      ) {
        return (
          (page - 1) * PAGE_SIZE +
          index +
          1
        );
      }
    }

    return null;
  }

  /*
    First try the previous position.
  */
  let rank = await checkPage(center);

  if (rank) {
    return rank;
  }

  /*
    Search nearby pages.
  */
  for (let distance = 1; distance <= 10; distance++) {
    const pages = [
      center - distance,
      center + distance,
    ].filter((page) => page >= 1);

    for (const page of pages) {
      rank = await checkPage(page);

      if (rank) {
        return rank;
      }
    }
  }

  /*
    If this is the first run, scan the first 20 pages.
    This covers the top 2000 leagues.
  */
  if (!Number.isFinite(previousRank)) {
    for (let page = 1; page <= 20; page++) {
      rank = await checkPage(page);

      if (rank) {
        return rank;
      }
    }
  }

  /*
    If the league wasn't found near the previous rank,
    expand progressively.

    This avoids downloading the entire leaderboard on every
    5-minute run.
  */
  const expansion = [
    25,
    50,
    75,
    100,
    150,
    200,
    300,
    400,
    500,
    700,
    900,
  ];

  for (const page of expansion) {
    rank = await checkPage(page);

    if (rank) {
      return rank;
    }
  }

  /*
    We do not invent a rank.
  */
  console.warn(
    `Could not find ${LEAGUE_NAME} in inspected leaderboard pages.`
  );

  return null;
}

/* =========================================================
   MEMBERS / CONTRIBUTIONS
========================================================= */

function buildRoster(league) {
  const roster = [];

  if (league.Owner?.UserID != null) {
    roster.push({
      userId: String(league.Owner.UserID),
      displayName:
        league.Owner.DisplayName ||
        String(league.Owner.UserID),
    });
  }

  if (Array.isArray(league.Members)) {
    for (const member of league.Members) {
      if (member?.UserID == null) {
        continue;
      }

      const userId = String(member.UserID);

      if (
        roster.some(
          (player) => player.userId === userId
        )
      ) {
        continue;
      }

      roster.push({
        userId,
        displayName:
          member.DisplayName || userId,
      });
    }
  }

  return roster.slice(0, 4);
}

function buildContributionMap(league) {
  const map = new Map();

  if (!Array.isArray(league.PointContributions)) {
    return map;
  }

  for (const entry of league.PointContributions) {
    if (entry?.UserID == null) {
      continue;
    }

    map.set(String(entry.UserID), {
      userId: String(entry.UserID),
      displayName:
        entry.DisplayName ||
        String(entry.UserID),
      points: Number(entry.Points) || 0,
      timestamp:
        Number.isFinite(Number(entry.Timestamp))
          ? Number(entry.Timestamp)
          : null,
    });
  }

  return map;
}

function buildPlayers(league) {
  const roster = buildRoster(league);
  const contributionMap =
    buildContributionMap(league);

  return roster.map((member) => {
    const contribution =
      contributionMap.get(member.userId);

    return {
      userId: member.userId,
      displayName:
        contribution?.displayName ||
        member.displayName ||
        member.userId,
      points:
        contribution?.points || 0,
      timestamp:
        contribution?.timestamp || null,
    };
  });
}

/* =========================================================
   HISTORY
========================================================= */

function addSnapshot(state, players, timestamp) {
  const playerPoints = {};

  for (const player of players) {
    playerPoints[player.userId] =
      Number(player.points) || 0;
  }

  state.snapshots.push({
    timestamp,
    players: playerPoints,
  });

  const cutoff =
    timestamp - HISTORY_RETENTION;

  state.snapshots =
    state.snapshots.filter(
      (snapshot) =>
        Number(snapshot.timestamp) >= cutoff
    );

  /*
    Remove snapshots that are almost identical in time.
    This prevents duplicate runs from bloating state.json.
  */
  const cleaned = [];

  for (const snapshot of state.snapshots) {
    const last =
      cleaned[cleaned.length - 1];

    if (
      !last ||
      Math.abs(
        snapshot.timestamp -
          last.timestamp
      ) >= 60
    ) {
      cleaned.push(snapshot);
    }
  }

  state.snapshots = cleaned;
}

function getPointsAtOrBefore(
  state,
  userId,
  targetTimestamp
) {
  let best = null;

  for (const snapshot of state.snapshots) {
    if (
      Number(snapshot.timestamp) <=
      targetTimestamp
    ) {
      if (
        !best ||
        Number(snapshot.timestamp) >
          Number(best.timestamp)
      ) {
        best = snapshot;
      }
    }
  }

  if (!best) {
    return null;
  }

  const points =
    best.players?.[userId];

  if (!Number.isFinite(Number(points))) {
    return null;
  }

  return Number(points);
}

function getDelta(
  state,
  userId,
  currentPoints,
  millisecondsAgo
) {
  const now = Date.now();
  const target =
    now - millisecondsAgo;

  const oldPoints =
    getPointsAtOrBefore(
      state,
      userId,
      target
    );

  if (oldPoints === null) {
    return null;
  }

  return currentPoints - oldPoints;
}

/* =========================================================
   ROBLOX AVATARS
========================================================= */

function getAvatarUrl(userIds) {
  if (!userIds.length) {
    return new Map();
  }

  return getJson(
    "https://thumbnails.roblox.com/v1/users/avatar-headshot" +
      `?userIds=${userIds.join(",")}` +
      "&size=150x150" +
      "&format=Png" +
      "&isCircular=true"
  )
    .then((response) => {
      const map = new Map();

      for (const item of response?.data || []) {
        if (
          item?.targetId != null &&
          item?.imageUrl
        ) {
          map.set(
            String(item.targetId),
            item.imageUrl
          );
        }
      }

      return map;
    })
    .catch((error) => {
      console.warn(
        "Could not load Roblox avatars:",
        error.message
      );

      return new Map();
    });
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          "User-Agent": "MGKK-Discord-Bot/2.0",
        },
      },
      (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          downloadBuffer(
            response.headers.location
          )
            .then(resolve)
            .catch(reject);

          return;
        }

        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Avatar HTTP ${response.statusCode}`
            )
          );
          return;
        }

        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          resolve(
            Buffer.concat(chunks)
          );
        });
      }
    ).on("error", reject);
  });
}

/* =========================================================
   SVG DASHBOARD
========================================================= */

const PLAYER_COLORS = [
  "#19c7ff",
  "#ff3ca6",
  "#ffab19",
  "#35e0b2",
];

function makeText(
  x,
  y,
  text,
  options = {}
) {
  const {
    size = 24,
    weight = 400,
    fill = "#ffffff",
    anchor = "start",
    opacity = 1,
    family = "Arial, Helvetica, sans-serif",
  } = options;

  return `
    <text
      x="${x}"
      y="${y}"
      font-family="${family}"
      font-size="${size}px"
      font-weight="${weight}"
      fill="${fill}"
      text-anchor="${anchor}"
      opacity="${opacity}"
    >${escapeXml(text)}</text>
  `;
}

function makeRoundedRect(
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

function makeDashboardSvg({
  league,
  rank,
  players,
  state,
  avatarBuffers,
}) {
  const width = 1600;
  const height = 1080;

  const bg = "#17191d";
  const panel = "#20242a";
  const panel2 = "#252a31";
  const border = "#30363e";
  const muted = "#8f98a5";
  const white = "#f4f6f8";

  let svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
    viewBox="0 0 ${width} ${height}"
  >

    <defs>

      <linearGradient
        id="headerGradient"
        x1="0"
        y1="0"
        x2="1"
        y2="1"
      >
        <stop offset="0%" stop-color="#202a35"/>
        <stop offset="100%" stop-color="#171a1f"/>
      </linearGradient>

      <filter
        id="shadow"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
      >
        <feDropShadow
          dx="0"
          dy="8"
          stdDeviation="12"
          flood-color="#000000"
          flood-opacity="0.30"
        />
      </filter>

    </defs>

    ${makeRoundedRect(
      0,
      0,
      width,
      height,
      34,
      bg
    )}

    ${makeRoundedRect(
      36,
      30,
      width - 72,
      145,
      24,
      "url(#headerGradient)",
      border,
      2
    )}

    ${makeText(
      75,
      82,
      `⭐ ${league.Name || LEAGUE_NAME}`,
      {
        size: 42,
        weight: 800,
        fill: white,
      }
    )}

    ${makeText(
      75,
      125,
      "League dashboard",
      {
        size: 22,
        weight: 500,
        fill: muted,
      }
    )}

    ${makeText(
      width - 75,
      80,
      rank ? `#${rank}` : "#—",
      {
        size: 42,
        weight: 800,
        fill: "#ffd35a",
        anchor: "end",
      }
    )}

    ${makeText(
      width - 75,
      122,
      "GLOBAL RANK",
      {
        size: 18,
        weight: 700,
        fill: muted,
        anchor: "end",
      }
    )}

    ${makeRoundedRect(
      36,
      200,
      width - 72,
      135,
      24,
      panel,
      border,
      2
    )}

    ${makeText(
      75,
      250,
      "TOTAL LEAGUE POINTS",
      {
        size: 18,
        weight: 700,
        fill: muted,
      }
    )}

    ${makeText(
      75,
      305,
      formatFullPoints(
        Number(league.Points) || 0
      ),
      {
        size: 46,
        weight: 800,
        fill: white,
      }
    )}

    ${makeText(
      width - 75,
      255,
      `${players.length}/4 MEMBERS`,
      {
        size: 20,
        weight: 700,
        fill: "#55d7ff",
        anchor: "end",
      }
    )}

    ${makeText(
      width - 75,
      302,
      "Live API data",
      {
        size: 18,
        weight: 500,
        fill: muted,
        anchor: "end",
      }
    )}

    ${makeText(
      55,
      395,
      "PLAYER CONTRIBUTIONS",
      {
        size: 20,
        weight: 800,
        fill: white,
      }
    )}

    ${makeRoundedRect(
      36,
      420,
      width - 72,
      300,
      24,
      panel,
      border,
      2
    )}
  `;

  /*
    Table header
  */

  svg += makeText(
    170,
    460,
    "PLAYER",
    {
      size: 16,
      weight: 700,
      fill: muted,
    }
  );

  svg += makeText(
    700,
    460,
    "CONTRIBUTED",
    {
      size: 16,
      weight: 700,
      fill: muted,
      anchor: "end",
    }
  );

  svg += makeText(
    880,
    460,
    "+1H",
    {
      size: 16,
      weight: 700,
      fill: muted,
      anchor: "end",
    }
  );

  svg += makeText(
    1050,
    460,
    "+24H",
    {
      size: 16,
      weight: 700,
      fill: muted,
      anchor: "end",
    }
  );

  svg += makeText(
    1230,
    460,
    "SHARE",
    {
      size: 16,
      weight: 700,
      fill: muted,
      anchor: "end",
    }
  );

  svg += makeText(
    1515,
    460,
    "UPDATED",
    {
      size: 16,
      weight: 700,
      fill: muted,
      anchor: "end",
    }
  );

  const totalPoints =
    players.reduce(
      (sum, player) =>
        sum + Number(player.points || 0),
      0
    );

  const rowHeight = 62;

  players.forEach((player, index) => {
    const y = 480 + index * rowHeight;
    const color =
      PLAYER_COLORS[index];

    if (index > 0) {
      svg += `
        <line
          x1="70"
          y1="${y - 5}"
          x2="${width - 70}"
          y2="${y - 5}"
          stroke="${border}"
          stroke-width="1"
        />
      `;
    }

    svg += `
      <rect
        x="52"
        y="${y + 8}"
        width="6"
        height="42"
        rx="3"
        fill="${color}"
      />
    `;

    /*
      Avatar
    */

    const avatar =
      avatarBuffers.get(player.userId);

    if (avatar) {
      const avatarData =
        avatar.toString("base64");

      svg += `
        <defs>
          <clipPath id="avatar-${index}">
            <circle
              cx="105"
              cy="${y + 29}"
              r="23"
            />
          </clipPath>
        </defs>

        <circle
          cx="105"
          cy="${y + 29}"
          r="25"
          fill="#343a43"
        />

        <image
          href="data:image/png;base64,${avatarData}"
          x="80"
          y="${y + 4}"
          width="50"
          height="50"
          preserveAspectRatio="xMidYMid slice"
          clip-path="url(#avatar-${index})"
        />
      `;
    } else {
      svg += `
        <circle
          cx="105"
          cy="${y + 29}"
          r="25"
          fill="#343a43"
        />
      `;
    }

    const name =
      String(player.displayName || player.userId);

    const points =
      Number(player.points) || 0;

    const delta1h =
      getDelta(
        state,
        player.userId,
        points,
        60 * 60 * 1000
      );

    const delta24h =
      getDelta(
        state,
        player.userId,
        points,
        24 * 60 * 60 * 1000
      );

    const share =
      totalPoints > 0
        ? (points / totalPoints) * 100
        : 0;

    let updated = "—";

    if (player.timestamp) {
      updated =
        new Date(
          player.timestamp * 1000
        ).toLocaleTimeString(
          "en-US",
          {
            hour: "2-digit",
            minute: "2-digit",
          }
        );
    }

    svg += makeText(
      170,
      y + 28,
      name.length > 22
        ? `${name.slice(0, 21)}…`
        : name,
      {
        size: 22,
        weight: 700,
        fill: white,
      }
    );

    svg += makeText(
      170,
      y + 48,
      `ID ${player.userId}`,
      {
        size: 13,
        weight: 500,
        fill: muted,
      }
    );

    svg += makeText(
      700,
      y + 37,
      formatPoints(points),
      {
        size: 23,
        weight: 800,
        fill: color,
        anchor: "end",
      }
    );

    svg += makeText(
      880,
      y + 37,
      formatDelta(delta1h),
      {
        size: 20,
        weight: 700,
        fill:
          delta1h === null
            ? muted
            : white,
        anchor: "end",
      }
    );

    svg += makeText(
      1050,
      y + 37,
      formatDelta(delta24h),
      {
        size: 20,
        weight: 700,
        fill:
          delta24h === null
            ? muted
            : white,
        anchor: "end",
      }
    );

    svg += makeText(
      1230,
      y + 37,
      `${share.toFixed(1)}%`,
      {
        size: 20,
        weight: 700,
        fill: color,
        anchor: "end",
      }
    );

    svg += makeText(
      1515,
      y + 37,
      updated,
      {
        size: 18,
        weight: 600,
        fill: muted,
        anchor: "end",
      }
    );
  });

  /*
    Chart
  */

  const chartX = 36;
  const chartY = 755;
  const chartW = width - 72;
  const chartH = 270;

  svg += makeText(
    55,
    745,
    "CONTRIBUTION HISTORY — LAST 24H",
    {
      size: 20,
      weight: 800,
      fill: white,
    }
  );

  svg += makeRoundedRect(
    chartX,
    chartY,
    chartW,
    chartH,
    24,
    panel,
    border,
    2
  );

  const historyStart =
    Date.now() -
    24 * 60 * 60 * 1000;

  const history =
    state.snapshots.filter(
      (snapshot) =>
        Number(snapshot.timestamp) >=
        historyStart
    );

  let maxValue = 1;

  for (const player of players) {
    for (const snapshot of history) {
      const value =
        Number(
          snapshot.players?.[
            player.userId
          ]
        ) || 0;

      maxValue =
        Math.max(maxValue, value);
    }
  }

  /*
    Grid
  */

  const plotLeft = chartX + 75;
  const plotRight = chartX + chartW - 30;
  const plotTop = chartY + 25;
  const plotBottom =
    chartY + chartH - 45;

  const plotW =
    plotRight - plotLeft;

  const plotH =
    plotBottom - plotTop;

  for (let i = 0; i <= 4; i++) {
    const y =
      plotTop +
      (plotH / 4) * i;

    svg += `
      <line
        x1="${plotLeft}"
        y1="${y}"
        x2="${plotRight}"
        y2="${y}"
        stroke="#30363e"
        stroke-width="1"
      />
    `;

    const value =
      maxValue -
      (maxValue / 4) * i;

    svg += makeText(
      plotLeft - 12,
      y + 6,
      formatPoints(value),
      {
        size: 14,
        weight: 600,
        fill: muted,
        anchor: "end",
      }
    );
  }

  /*
    X-axis labels
  */

  const now = Date.now();

  const labels = [
    {
      x: plotLeft,
      text: "24H",
    },
    {
      x: plotLeft + plotW * 0.25,
      text: "18H",
    },
    {
      x: plotLeft + plotW * 0.5,
      text: "12H",
    },
    {
      x: plotLeft + plotW * 0.75,
      text: "6H",
    },
    {
      x: plotRight,
      text: "NOW",
    },
  ];

  for (const label of labels) {
    svg += makeText(
      label.x,
      chartY + chartH - 15,
      label.text,
      {
        size: 14,
        weight: 700,
        fill: muted,
        anchor: "middle",
      }
    );
  }

  /*
    Player lines
  */

  players.forEach((player, index) => {
    const color =
      PLAYER_COLORS[index];

    const points = [];

    if (history.length === 0) {
      const current =
        Number(player.points) || 0;

      points.push({
        timestamp: now,
        value: current,
      });
    } else {
      for (const snapshot of history) {
        const value =
          Number(
            snapshot.players?.[
              player.userId
            ]
          ) || 0;

        points.push({
          timestamp:
            Number(snapshot.timestamp),
          value,
        });
      }

      /*
        Add current value as final point.
      */
      points.push({
        timestamp: now,
        value:
          Number(player.points) || 0,
      });
    }

    const linePoints =
      points
        .map((point) => {
          const ratio =
            clamp(
              (point.timestamp -
                historyStart) /
                (24 * 60 * 60 * 1000),
              0,
              1
            );

          const x =
            plotLeft +
            ratio * plotW;

          const y =
            plotBottom -
            (point.value / maxValue) *
              plotH;

          return `${x.toFixed(1)},${y.toFixed(
            1
          )}`;
        })
        .join(" ");

    svg += `
      <polyline
        points="${linePoints}"
        fill="none"
        stroke="${color}"
        stroke-width="4"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.95"
      />
    `;

    /*
      Current point
    */

    const currentX = plotRight;

    const currentValue =
      Number(player.points) || 0;

    const currentY =
      plotBottom -
      (currentValue / maxValue) *
        plotH;

    svg += `
      <circle
        cx="${currentX}"
        cy="${currentY}"
        r="6"
        fill="${color}"
      />
    `;

    /*
      Legend
    */

    const legendX =
      plotLeft +
      index * 320;

    svg += `
      <circle
        cx="${legendX}"
        cy="${chartY + 22}"
        r="5"
        fill="${color}"
      />
    `;

    svg += makeText(
      legendX + 12,
      chartY + 27,
      player.displayName,
      {
        size: 15,
        weight: 700,
        fill: white,
      }
    );
  });

  svg += makeText(
    width - 55,
    height - 18,
    "MGKK • BIG Games API",
    {
      size: 13,
      weight: 600,
      fill: muted,
      anchor: "end",
    }
  );

  svg += "</svg>";

  return svg;
}

/* =========================================================
   RENDER PNG
========================================================= */

async function renderDashboard({
  league,
  rank,
  players,
  state,
}) {
  const userIds =
    players.map(
      (player) => player.userId
    );

  const avatarUrls =
    await getAvatarUrl(userIds);

  const avatarBuffers =
    new Map();

  for (const player of players) {
    const url =
      avatarUrls.get(player.userId);

    if (!url) {
      continue;
    }

    try {
      const buffer =
        await downloadBuffer(url);

      avatarBuffers.set(
        player.userId,
        buffer
      );
    } catch (error) {
      console.warn(
        `Avatar failed for ${player.userId}:`,
        error.message
      );
    }
  }

  const svg = makeDashboardSvg({
    league,
    rank,
    players,
    state,
    avatarBuffers,
  });

  return sharp(
    Buffer.from(svg)
  )
    .png({
      compressionLevel: 9,
      quality: 100,
    })
    .toBuffer();
}

/* =========================================================
   DISCORD
========================================================= */

async function getDiscordChannel(client) {
  const channel =
    await client.channels.fetch(
      DISCORD_CHANNEL_ID
    );

  if (!channel) {
    throw new Error(
      "Discord channel was not found."
    );
  }

  if (
    !channel.isTextBased() ||
    !channel.messages
  ) {
    throw new Error(
      "DISCORD_CHANNEL_ID is not a text channel."
    );
  }

  return channel;
}

async function updateDashboardMessage(
  channel,
  state,
  pngBuffer,
  league,
  rank
) {
  const attachment = {
    attachment: pngBuffer,
    name: "mgkk-dashboard.png",
    description:
      "MGKK League dashboard",
  };

  /*
    Try editing the existing dashboard.
  */

  if (state.dashboardMessageId) {
    try {
      const message =
        await channel.messages.fetch(
          state.dashboardMessageId
        );

      await message.edit({
        content: "",
        embeds: [],
        files: [attachment],
      });

      console.log(
        `Dashboard updated: ${message.id}`
      );

      return message.id;
    } catch (error) {
      console.warn(
        "Existing dashboard message could not be edited:",
        error.message
      );

      state.dashboardMessageId = null;
    }
  }

  /*
    Create it once if there isn't one.
  */

  const message =
    await channel.send({
      content: "",
      files: [attachment],
    });

  state.dashboardMessageId =
    message.id;

  console.log(
    `Dashboard created: ${message.id}`
  );

  return message.id;
}

/* =========================================================
   RANK CHANGE NOTIFICATION
========================================================= */

async function sendRankNotification(
  channel,
  league,
  previousRank,
  currentRank
) {
  if (
    !Number.isFinite(previousRank) ||
    !Number.isFinite(currentRank)
  ) {
    return;
  }

  if (previousRank === currentRank) {
    return;
  }

  const difference =
    previousRank - currentRank;

  const improved = difference > 0;

  const embed =
    new EmbedBuilder()
      .setTitle(
        improved
          ? "📈 MGKK — Increased!"
          : "📉 MGKK — Decreased"
      )
      .setDescription(
        improved
          ? `**${league.Name}** moved **${Math.abs(
              difference
            )} position${
              Math.abs(difference) === 1
                ? ""
                : "s"
            } up** in the League leaderboard.`
          : `**${league.Name}** moved **${Math.abs(
              difference
            )} position${
              Math.abs(difference) === 1
                ? ""
                : "s"
            } down** in the League leaderboard.`
      )
      .addFields(
        {
          name: "⬅️ Previous place",
          value: `#${previousRank}`,
          inline: true,
        },
        {
          name: "🏆 Current place",
          value: `#${currentRank}`,
          inline: true,
        },
        {
          name: "💎 Points",
          value: formatFullPoints(
            Number(league.Points) || 0
          ),
          inline: true,
        }
      )
      .setFooter({
        text: "MGKK League • BIG Games API",
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
  const state = loadState();

  console.log(
    `Checking league ${LEAGUE_NAME}...`
  );

  /*
    1. Get actual league data.
  */

  const league =
    await getLeague();

  /*
    2. Build roster from Owner + Members.
  */

  const players =
    buildPlayers(league);

  if (players.length === 0) {
    throw new Error(
      "League has no Owner/Members in API response."
    );
  }

  console.log(
    `League: ${league.Name}`
  );

  console.log(
    `Points: ${formatFullPoints(
      league.Points
    )}`
  );

  console.log(
    `Roster: ${players
      .map(
        (player) =>
          `${player.displayName}=${formatPoints(
            player.points
          )}`
      )
      .join(", ")}`
  );

  /*
    3. Calculate current rank.
  */

  const currentRank =
    await getLeagueRank(
      Number(league.Points) || 0,
      state.previousRank
    );

  console.log(
    `Rank: ${currentRank ?? "unknown"}`
  );

  /*
    4. Add real API snapshot.
  */

  const now =
    Date.now();

  /*
    Prevent duplicate snapshots if GitHub somehow
    runs the job twice within a minute.
  */

  const lastSnapshot =
    state.snapshots[
      state.snapshots.length - 1
    ];

  if (
    !lastSnapshot ||
    now -
      Number(lastSnapshot.timestamp) >=
      60_000
  ) {
    addSnapshot(
      state,
      players,
      now
    );
  }

  /*
    5. Discord.
  */

  const client =
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
      ],
    });

  await client.login(
    DISCORD_TOKEN
  );

  try {
    const channel =
      await getDiscordChannel(
        client
      );

    /*
      Rank notification BEFORE updating stored rank.
    */

    if (
      currentRank !== null &&
      Number.isFinite(currentRank)
    ) {
      await sendRankNotification(
        channel,
        league,
        state.previousRank,
        currentRank
      );

      state.previousRank =
        currentRank;
    }

    /*
      6. Generate ONE dashboard image.
    */

    const pngBuffer =
      await renderDashboard({
        league,
        rank: currentRank,
        players,
        state,
      });

    /*
      7. Update the SAME Discord message.
    */

    await updateDashboardMessage(
      channel,
      state,
      pngBuffer,
      league,
      currentRank
    );
  } finally {
    client.destroy();
  }

  /*
    8. Save state.
  */

  saveState(state);

  console.log(
    "MGKK check completed successfully."
  );
}

main().catch((error) => {
  console.error(
    "MGKK BOT ERROR:"
  );
  console.error(error);

  process.exitCode = 1;
});
