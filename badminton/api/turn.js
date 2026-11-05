// Vercel serverless function: GET /api/turn -> { iceServers: [...] }
// Hands the browser short-lived Cloudflare TURN credentials, so the long-lived API token never reaches the page.
// Set these in Vercel (Project → Settings → Environment Variables):
//   CF_TURN_KEY_ID     the TURN key's id
//   CF_TURN_API_TOKEN  the TURN key's API token (secret)
const TTL = 6 * 60 * 60; // credentials stay valid for 6 hours, longer than any match

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = process.env.CF_TURN_KEY_ID, token = process.env.CF_TURN_API_TOKEN;
  if (!id || !token) return res.status(503).json({ error: "TURN is not configured" });
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!r.ok) return res.status(502).json({ error: `Cloudflare answered ${r.status}` });
    const { iceServers } = await r.json();
    // browsers refuse port 53 and time out on it; Cloudflare's docs advise dropping those URLs
    const servers = (Array.isArray(iceServers) ? iceServers : [iceServers]).map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    return res.status(200).json({ iceServers: servers.filter((s) => s.urls.length) });
  } catch (err) {
    return res.status(502).json({ error: String(err) });
  }
};
