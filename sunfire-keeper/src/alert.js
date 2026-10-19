/** Posts a message to a Discord-style webhook. Silently skipped when no URL is set. */
export function makeAlert(url, { fetchFn = fetch, log = console.log } = {}) {
  return async (text) => {
    log(`ALERT ${text}`);
    if (!url) return;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: `SunFire keeper: ${text}`.slice(0, 1900) }),
      });
      if (!res.ok) log(`Alert webhook answered ${res.status}`);
    } catch (e) {
      log(`Alert webhook failed: ${e.message}`);
    }
  };
}
