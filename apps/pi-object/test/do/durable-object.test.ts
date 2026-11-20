import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const token = "test-token";

function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return exports.default.fetch(new Request(`https://example.com${path}`, { ...init, headers }));
}

describe("PiAgent", () => {
  it("refuses a request when the device token is absent", async () => {
    const response = await exports.default.fetch(new Request("https://example.com/v1/cost"));
    expect(response.status).toBe(401);
  });

  it("refuses a request with the wrong device token", async () => {
    const response = await exports.default.fetch(new Request("https://example.com/v1/cost", { headers: { authorization: "Bearer wrong" } }));
    expect(response.status).toBe(401);
  });

  it("accepts the device token and reaches the route", async () => {
    const response = await call("/file");
    expect(response.status).toBe(400);
  });

  it("keeps one object's stored flag and keeps a second identity independent", async () => {
    const first = exports.PiAgent.get(exports.PiAgent.idFromName("agent-a"));
    const second = exports.PiAgent.get(exports.PiAgent.idFromName("agent-b"));
    await first.setFreeTier("deepseek", true);
    await second.setFreeTier("deepseek", false);
    const firstReport = await first.costSnapshot();
    const secondReport = await second.costSnapshot();
    expect(firstReport.objects.find((object) => object.id === "deepseek")?.freeTier).toBe(true);
    expect(secondReport.objects.find((object) => object.id === "deepseek")?.freeTier).toBe(false);
  });

  it("refuses a run when Cloudflare usage cannot be priced", async () => {
    const agent = exports.PiAgent.get(exports.PiAgent.idFromName("agent-budget"));
    const result = await agent.run("do nothing");
    expect("budget" in result).toBe(true);
    if (!("budget" in result)) return;
    expect(result.budget.allowed).toBe(false);
  });
});
