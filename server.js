// relay/server.js
// Tiny relay between your Roblox game server and Roblox Open Cloud.
// Roblox game servers cannot call roblox.com APIs, so this does it for them.
//
// Env vars:
//   ROBLOX_API_KEY  Open Cloud key with group:read + group:write on your group
//   GROUP_ID        your group ID
//   SHARED_SECRET   same string as RELAY_SECRET in the Roblox script
//   PORT            optional, default 3000

const express = require("express");

const API_KEY = process.env.ROBLOX_API_KEY;
const GROUP_ID = process.env.GROUP_ID;
const SHARED_SECRET = process.env.SHARED_SECRET;
const PORT = process.env.PORT || 3000;

if (!API_KEY || !GROUP_ID || !SHARED_SECRET) {
  console.error("Missing ROBLOX_API_KEY, GROUP_ID or SHARED_SECRET");
  process.exit(1);
}

const BASE = "https://apis.roblox.com/cloud/v2";
const app = express();
app.use(express.json());

async function roblox(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// Cache group roles for a few minutes (rank number -> role id)
let rolesCache = { at: 0, byRank: new Map() };
async function getRoleByRank(rank) {
  if (Date.now() - rolesCache.at > 5 * 60 * 1000) {
    const byRank = new Map();
    let pageToken = "";
    do {
      const q = pageToken ? `?maxPageSize=100&pageToken=${encodeURIComponent(pageToken)}` : "?maxPageSize=100";
      const r = await roblox(`/groups/${GROUP_ID}/roles${q}`);
      if (!r.ok) throw new Error(`Could not list roles (${r.status})`);
      for (const role of r.json.groupRoles || []) {
        byRank.set(Number(role.rank), role);
      }
      pageToken = r.json.nextPageToken || "";
    } while (pageToken);
    rolesCache = { at: Date.now(), byRank };
  }
  return rolesCache.byRank.get(rank);
}

app.post("/promote", async (req, res) => {
  if (req.get("x-shared-secret") !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const userId = Number(req.body?.userId);
  const targetRank = Number(req.body?.targetRank);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(targetRank) || targetRank <= 0 || targetRank > 255) {
    return res.status(400).json({ ok: false, error: "Bad request" });
  }

  try {
    const targetRole = await getRoleByRank(targetRank);
    if (!targetRole) {
      return res.status(500).json({ ok: false, error: `No group role with rank ${targetRank}` });
    }

    // Look up the user's current membership.
    const current = await roblox(`/groups/${GROUP_ID}/memberships?filter=${encodeURIComponent(`user == 'users/${userId}'`)}`);
    if (!current.ok) {
      return res.status(502).json({ ok: false, error: "Could not read group membership" });
    }
    const membership = (current.json.groupMemberships || [])[0];
    if (!membership) {
      return res.status(400).json({ ok: false, error: "You are not in the group." });
    }

    // Never demote, and never touch anyone already at or above the target.
    const currentRoleId = membership.role.split("/").pop();
    const rolesRes = await roblox(`/groups/${GROUP_ID}/roles/${currentRoleId}`);
    const currentRank = rolesRes.ok ? Number(rolesRes.json.rank) : null;
    if (currentRank !== null && currentRank >= targetRank) {
      return res.json({ ok: true, message: "You already hold this rank or higher." });
    }

    const membershipId = membership.path.split("/").pop();
    const update = await roblox(`/groups/${GROUP_ID}/memberships/${membershipId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: `groups/${GROUP_ID}/roles/${targetRole.id}` }),
    });
    if (!update.ok) {
      console.error("Update failed", update.status, update.text);
      return res.status(502).json({ ok: false, error: "Roblox refused the rank change." });
    }

    return res.json({ ok: true, message: `You have been promoted to ${targetRole.displayName}!` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`Relay listening on ${PORT}`));
