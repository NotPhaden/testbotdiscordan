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
const ROBLOX_USERS_API = "https://users.roblox.com/v1/users";

const LEAGUE_NAME = process.env.LEAGUE_NAME || "MGKK";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const STATE_FILE = path.join(process.cwd(), "state.json");

const HISTORY_RETENTION = 7 * 24 * 60 * 60 * 1000;

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN is missing.");
}

if (!DISCORD_CHANNEL_ID) {
  throw new Error("DISCORD_CHANNEL_ID is missing.");
}

/* =========================================================
   STATE
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
    const state = JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );

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
    console.warn(
      "state.json is invalid. Starting fresh."
    );

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

/* =========================================================
   FORMATTERS
========================================================= */

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
          "User-Agent": "MGKK-Discord-Bot/3.0",
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

/* =========================================================
   LEAGUE
========================================================= */

async function getLeague() {
  const url =
    `${API_BASE}/leagues/` +
    encodeURIComponent(LEAGUE_NAME);

  const response = await getJson(url);

  if (!response?.data) {
    throw new Error(
      "League API returned no data."
    );
  }

  return response.data;
}

/* =========================================================
   LEAGUE RANK
========================================================= */

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

  let rank = await checkPage(center);

  if (rank) {
    return rank;
  }

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

  if (!Number.isFinite(previousRank)) {
    for (let page = 1; page <= 20; page++) {
      rank = await checkPage(page);

      if (rank) {
        return rank;
      }
    }
  }

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

  return null;
}

/* =========================================================
   ROBLOX DISPLAY NAMES
========================================================= */

async function getRobloxUserProfiles(userIds) {
  const uniqueIds = [
    ...new Set(
      userIds
        .map((id) => String(id))
        .filter(Boolean)
    ),
  ];

  const profiles = new Map();

  if (!uniqueIds.length) {
    return profiles;
  }

  for (let i = 0; i < uniqueIds.length; i += 50) {
    const batch = uniqueIds.slice(i, i + 50);

    try {
      const response = await getJson(
        `${ROBLOX_USERS_API}?userIds=${batch.join(",")}`
      );

      for (const user of response?.data || []) {
        if (user?.id == null) {
          continue;
        }

        const id = String(user.id);

        profiles.set(id, {
          username: user.name || id,
          displayName:
            user.displayName ||
            user.name ||
            id,
        });
      }
    } catch (error) {
      console.warn(
        `Could not resolve Roblox display names:`,
        error.message
      );
    }
  }

  return profiles;
}

/* =========================================================
   MEMBERS
========================================================= */

function buildRoster(league) {
  const roster = [];

  if (league.Owner?.UserID != null) {
    roster.push({
      userId: String(league.Owner.UserID),

      displayName:
        league.Owner.DisplayName ||
        league.Owner.displayName ||
        league.Owner.Name ||
        league.Owner.name ||
        null,

      username:
        league.Owner.Username ||
        league.Owner.UserName ||
        league.Owner.Name ||
        league.Owner.name ||
        null,
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
          (player) =>
            player.userId === userId
        )
      ) {
        continue;
      }

      roster.push({
        userId,

        displayName:
          member.DisplayName ||
          member.displayName ||
          member.Name ||
          member.name ||
          null,

        username:
          member.Username ||
          member.UserName ||
          member.Name ||
          member.name ||
          null,
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

    const userId = String(entry.UserID);

    map.set(userId, {
      userId,

      displayName:
        entry.DisplayName ||
        entry.displayName ||
        entry.Name ||
        entry.name ||
        null,

      username:
        entry.Username ||
        entry.UserName ||
        entry.Name ||
        entry.name ||
        null,

      points:
        Number(entry.Points) || 0,

      timestamp:
        Number.isFinite(Number(entry.Timestamp))
          ? Number(entry.Timestamp)
          : null,
    });
  }

  return map;
}

async function buildPlayers(league) {
  const roster = buildRoster(league);

  const contributionMap =
    buildContributionMap(league);

  const robloxProfiles =
    await getRobloxUserProfiles(
      roster.map(
        (member) => member.userId
      )
    );

  return roster.map((member) => {
    const contribution =
      contributionMap.get(
        member.userId
      );

    const profile =
      robloxProfiles.get(
        member.userId
      );

    return {
      userId: member.userId,

      /*
       * IMPORTANT:
       * Roblox Display Name is now the primary name.
       */
      displayName:
        profile?.displayName ||
        member.displayName ||
        contribution?.displayName ||
        profile?.username ||
        member.username ||
        contribution?.username ||
        `Player ${member.userId}`,

      username:
        profile?.username ||
        member.username ||
        contribution?.username ||
        null,

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

function addSnapshot(
  state,
  players,
  timestamp
) {
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

  if (
    !Number.isFinite(Number(points))
  ) {
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
  const target =
    Date.now() -
    millisecondsAgo;

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
      "&size=420x420" +
      "&format=Png" +
      "&isCircular=true"
  )
    .then((response) => {
      const map = new Map();

      for (
        const item of response?.data || []
      ) {
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
  return new Promise(
    (resolve, reject) => {
      https
        .get(
          url,
          {
            headers: {
              "User-Agent":
                "MGKK-Discord-Bot/3.0",
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

            response.on(
              "data",
              (chunk) => {
                chunks.push(chunk);
              }
            );

            response.on(
              "end",
              () => {
                resolve(
                  Buffer.concat(chunks)
                );
              }
            );
          }
        )
        .on("error", reject);
    }
  );
}

/* =========================================================
   SVG DASHBOARD
   SAME VISUAL STYLE
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
    family =
      "Arial, Helvetica, sans-serif",
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
  const height = 1160;

  const bg = "#17191d";
  const panel = "#20242a";
  const border = "#30363e";
  const muted = "#8f98a5";
  const white = "#f4f6f8";
  const gold = "#ffd35a";
  const success = "#55d7ff";

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
        <stop
          offset="0%"
          stop-color="#202a35"
        />

        <stop
          offset="100%"
          stop-color="#171a1f"
        />
      </linearGradient>

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
        fill: gold,
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
        fill: success,
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

  const topPlayer = [...players].sort(
    (a, b) =>
      (Number(b.points) || 0) -
      (Number(a.points) || 0)
  )[0];

  if (topPlayer) {
    svg += makeRoundedRect(
      1275,
      235,
      280,
      58,
      16,
      "#2d2a20",
      gold,
      1
    );

    svg += makeText(
      1293,
      259,
      "👑 TOP CONTRIBUTOR",
      {
        size: 13,
        weight: 800,
        fill: gold,
      }
    );

    svg += makeText(
      1293,
      282,
      String(
        topPlayer.displayName
      ).slice(0, 24),
      {
        size: 16,
        weight: 700,
        fill: white,
      }
    );
  }

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
        sum +
        Number(player.points || 0),
      0
    );

  const rowHeight = 62;

  players.forEach(
    (player, index) => {
      const y =
        480 + index * rowHeight;

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

      const avatar =
        avatarBuffers.get(
          player.userId
        );

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
        String(
          player.displayName ||
            `Player ${player.userId}`
        );

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

      /*
       * Username / ID stays secondary only.
       * Display Name is now the main visible name.
       */

      const secondaryIdentity =
        player.username &&
        player.username !== name
          ? `@${player.username}`
          : `Roblox ID ${player.userId}`;

      svg += makeText(
        170,
        y + 48,
        secondaryIdentity.length > 30
          ? `${secondaryIdentity.slice(0, 29)}…`
          : secondaryIdentity,
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
    }
  );

  /* =====================================================
     CHART
  ===================================================== */

  const chartX = 36;
  const chartY = 775;
  const chartW = width - 72;
  const chartH = 320;

  svg += makeText(
    55,
    765,
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
        Math.max(
          maxValue,
          value
        );
    }
  }

  const plotLeft =
    chartX + 75;

  const plotRight =
    chartX +
    chartW -
    30;

  const plotTop =
    chartY + 25;

  const plotBottom =
    chartY +
    chartH -
    45;

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
        stroke="${border}"
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

  const labels = [
    {
      x: plotLeft,
      text: "24H",
    },
    {
      x:
        plotLeft +
        plotW * 0.25,
      text: "18H",
    },
    {
      x:
        plotLeft +
        plotW * 0.5,
      text: "12H",
    },
    {
      x:
        plotLeft +
        plotW * 0.75,
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

  players.forEach(
    (player, index) => {
      const color =
        PLAYER_COLORS[index];

      const points = [];

      if (history.length === 0) {
        points.push({
          timestamp: Date.now(),
          value:
            Number(player.points) || 0,
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
              Number(
                snapshot.timestamp
              ),
            value,
          });
        }

        points.push({
          timestamp: Date.now(),
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
                  (24 *
                    60 *
                    60 *
                    1000),
                0,
                1
              );

            const x =
              plotLeft +
              ratio * plotW;

            const y =
              plotBottom -
              (point.value /
                maxValue) *
                plotH;

            return `${x.toFixed(
              1
            )},${y.toFixed(1)}`;
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

      const currentX =
        plotRight;

      const currentValue =
        Number(player.points) || 0;

      const currentY =
        plotBottom -
        (currentValue /
          maxValue) *
          plotH;

      svg += `
        <circle
          cx="${currentX}"
          cy="${currentY}"
          r="6"
          fill="${color}"
        />
      `;

      const legendStep =
        players.length > 1
          ? Math.min(
              300,
              plotW /
                Math.max(
                  players.length - 1,
                  1
                )
            )
          : 0;

      const legendX =
        players.length === 1
          ? plotLeft
          : plotLeft +
            index * legendStep;

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
    }
  );

  svg += makeText(
    width - 55,
    height - 18,
    "MGKK • BIG Games API • LIVE SNAPSHOT",
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
      avatarUrls.get(
        player.userId
      );

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

  const svg =
    makeDashboardSvg({
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
   DISCORD CHANNEL
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

/* =========================================================
   DASHBOARD MESSAGE
========================================================= */

async function updateDashboardMessage(
  channel,
  state,
  pngBuffer
) {
  const attachment = {
    attachment: pngBuffer,
    name: "mgkk-dashboard.png",
    description:
      "MGKK League dashboard",
  };

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

      state.dashboardMessageId =
        null;
    }
  }

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
   TEXT UPDATE MESSAGE
========================================================= */

async function sendUpdateMessage(
  channel,
  league,
  previousRank,
  currentRank
) {
  const now = new Date();

  const timestamp =
    now.toLocaleString(
      "en-US",
      {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }
    ) + " UTC";

  let title = "🔄 MGKK — Rank Update";
  let description =
    "The MGKK leaderboard has been updated.";

  let color = 0x55d7ff;

  if (
    Number.isFinite(previousRank) &&
    Number.isFinite(currentRank)
  ) {
    if (currentRank < previousRank) {
      title = "📈 MGKK — Advanced";
      description =
        `MGKK has **advanced** from **#${previousRank}** to **#${currentRank}**.`;
      color = 0x35e0b2;
    } else if (
      currentRank > previousRank
    ) {
      title = "📉 MGKK — Fell";
      description =
        `MGKK has **fallen** from **#${previousRank}** to **#${currentRank}**.`;
      color = 0xff5f6d;
    } else {
      title = "🔄 MGKK — Rank Checked";
      description =
        `MGKK remains at **#${currentRank}**.`;
      color = 0x55d7ff;
    }
  } else if (
    Number.isFinite(currentRank)
  ) {
    title = "🚀 MGKK — Rank Detected";
    description =
      `MGKK is currently ranked **#${currentRank}**.`;
    color = 0x55d7ff;
  }

  const embed =
    new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
      .addFields({
        name: "🏆 Current Rank",
        value: currentRank
          ? `#${currentRank}`
          : "Unknown",
        inline: true,
      })
      .addFields({
        name: "💎 League Points",
        value:
          formatFullPoints(
            Number(league.Points) || 0
          ),
        inline: true,
      })
      .addFields({
        name: "🕐 Updated",
        value: timestamp,
        inline: true,
      })
      .setFooter({
        text:
          "MGKK League • BIG Games API",
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
  const state =
    loadState();

  console.log(
    `Checking league ${LEAGUE_NAME}...`
  );

  const league =
    await getLeague();

  const players =
    await buildPlayers(league);

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

  const currentRank =
    await getLeagueRank(
      Number(league.Points) || 0,
      state.previousRank
    );

  console.log(
    `Rank: ${currentRank ?? "unknown"}`
  );

  const now =
    Date.now();

  const lastSnapshot =
    state.snapshots[
      state.snapshots.length - 1
    ];

  if (
    !lastSnapshot ||
    now -
      Number(
        lastSnapshot.timestamp
      ) >= 60_000
  ) {
    addSnapshot(
      state,
      players,
      now
    );
  }

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
     * Send a separate English status message
     * so every update is easy to identify.
     */
    await sendUpdateMessage(
      channel,
      league,
      state.previousRank,
      currentRank
    );

    /*
     * Keep the beautiful dashboard image
     * exactly as before.
     */
    await renderAndUpdate(
      channel,
      state,
      league,
      players,
      currentRank
    );

    if (
      currentRank !== null &&
      Number.isFinite(currentRank)
    ) {
      state.previousRank =
        currentRank;
    }
  } finally {
    client.destroy();
  }

  saveState(state);

  console.log(
    "MGKK check completed successfully."
  );
}

/* =========================================================
   RENDER + UPDATE
========================================================= */

async function renderAndUpdate(
  channel,
  state,
  league,
  players,
  currentRank
) {
  const pngBuffer =
    await renderDashboard({
      league,
      rank: currentRank,
      players,
      state,
    });

  await updateDashboardMessage(
    channel,
    state,
    pngBuffer
  );
}

main().catch((error) => {
  console.error(
    "MGKK BOT ERROR:"
  );

  console.error(error);

  process.exitCode = 1;
});
