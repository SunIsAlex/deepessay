export default async function getRequestBody(request) {
  const contentType = request.headers.get?.("content-type") || "";
  if (contentType.includes("application/json")) return await request.json();
  const text = await request.text();
  try { return JSON.parse(text); } catch { return text; }
}
