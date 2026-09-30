// Hourly trigger. The station archive syncs at :15, so the model runs at :25.
// Scheduled functions are limited to 30 s, so this only starts the background run.
export default async () => {
  const base = Netlify.env.get("URL") || process.env.URL;
  const token = Netlify.env.get("RUN_TOKEN");
  if (!base || !token) { console.log("schedule: URL or RUN_TOKEN missing"); return; }
  const res = await fetch(`${base}/.netlify/functions/run-background`, { method: "POST", headers: { "x-run-token": token } });
  console.log(`schedule: run-background → ${res.status}`);
};

export const config = { schedule: "25 * * * *" };
