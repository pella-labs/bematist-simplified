const port = Number(process.env.PORT ?? 8000);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[api] listening on http://localhost:${server.port}`);
