// Repo lifecycle over HTTP for the offline e2e: create (returns the loopback Git remote and a repo token), read, delete.
// Dev-only: it binds to loopback and holds no credentials.

interface ArtifactsRepoInfo {
  name: string;
  remote: string;
  token: string;
}
interface Env {
  ARTIFACTS: {
    create(name: string): Promise<ArtifactsRepoInfo>;
    delete(name: string): Promise<unknown>;
    get(name: string): Promise<{ info(): Promise<{ name: string }> }>;
  };
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok\n");

    if (request.method === "POST" && url.pathname === "/repos") {
      const body = (await request.json()) as { name?: unknown };
      if (typeof body.name !== "string" || !NAME.test(body.name)) return new Response("name required\n", { status: 400 });
      const created = await env.ARTIFACTS.create(body.name);
      return Response.json({ name: created.name, remote: created.remote, token: created.token });
    }

    const repo = url.pathname.match(/^\/repos\/([a-z0-9][a-z0-9._-]{0,62})$/);
    if (repo && request.method === "GET") {
      try {
        const handle = await env.ARTIFACTS.get(repo[1]);
        const info = await handle.info();
        return Response.json({ name: info.name });
      } catch {
        return new Response("not found\n", { status: 404 });
      }
    }
    if (repo && request.method === "DELETE") {
      await env.ARTIFACTS.delete(repo[1]);
      return new Response(null, { status: 204 });
    }
    return new Response("not found\n", { status: 404 });
  },
};
