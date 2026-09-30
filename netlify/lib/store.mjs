import { getStore } from "@netlify/blobs";

export const STORE_NAME = "snowpack-v1";
export const blobStore = () => getStore({ name: STORE_NAME, consistency: "strong" });

export function json(body, { status = 200, maxAge = 60, sMaxAge = 300 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=600`,
    },
  });
}

export const nowHour = () => Math.floor(Date.now() / 3600000);
