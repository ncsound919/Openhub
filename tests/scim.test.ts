// SCIM 2.0 provisioning tests (Phase 1.3): bearer gate, create/list/filter,
// role + active updates, deprovision, and the seat cap — against a fake store.
import { beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createScimRouter, type ScimUserStore } from "../src/auth/scim";

interface Row {
  id: string; email: string; username: string;
  firstName?: string | null; lastName?: string | null;
  role?: string; active: boolean; providerAccountId?: string | null; loginProvider?: string;
  password?: string;
}

class FakeStore implements ScimUserStore {
  users: Row[] = [];
  private n = 0;
  async findById(id: string) { return (this.users.find((u) => u.id === id) as never) ?? null; }
  async findByEmail(email: string) { return (this.users.find((u) => u.email === email) as never) ?? null; }
  async findByUsername(username: string) { return (this.users.find((u) => u.username === username) as never) ?? null; }
  async create(data: { email?: string; username?: string; firstName?: string; lastName?: string; role?: string; providerAccountId?: string; loginProvider?: string }) {
    const u: Row = {
      id: `u${++this.n}`, email: String(data.email), username: data.username || String(data.email).split("@")[0],
      firstName: data.firstName ?? null, lastName: data.lastName ?? null, role: data.role, active: true,
      providerAccountId: data.providerAccountId ?? null, loginProvider: data.loginProvider ?? "local",
    };
    this.users.push(u);
    return u as never;
  }
  async listUsers(limit: number, offset: number) { return this.users.slice(offset, offset + limit) as never; }
  async countUsers() { return this.users.length; }
  async countActiveUsers() { return this.users.filter((u) => u.active).length; }
  async updateRole(id: string, role: string | null) { const u = this.users.find((x) => x.id === id); if (!u) return false; u.role = role ?? undefined; return true; }
  async setActive(id: string, active: boolean) { const u = this.users.find((x) => x.id === id); if (!u) return false; u.active = active; return true; }
  async updateProfile(id: string, d: { firstName?: string | null; lastName?: string | null }) { const u = this.users.find((x) => x.id === id); if (!u) return; if (d.firstName !== undefined) u.firstName = d.firstName; if (d.lastName !== undefined) u.lastName = d.lastName; }
  async deleteUser(id: string) { this.users = this.users.filter((u) => u.id !== id); }
  async isActive(id: string) { const u = this.users.find((x) => x.id === id); return u ? u.active : null; }
}

const AUTH = "Bearer scim-token";
function appWith(store: FakeStore, opts: { token?: string; maxSeats?: number | null } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createScimRouter({ store, env: { SCIM_BEARER_TOKEN: opts.token ?? "scim-token" } as NodeJS.ProcessEnv, maxSeats: opts.maxSeats ?? null }));
  return app;
}

let store: FakeStore;
beforeEach(() => { store = new FakeStore(); });

describe("SCIM auth gate", () => {
  it("503s when no SCIM token is configured (never falls open)", async () => {
    const app = appWith(store, { token: "" });
    expect((await request(app).get("/scim/v2/Users")).status).toBe(503);
  });
  it("401s a wrong or missing bearer token", async () => {
    const app = appWith(store);
    expect((await request(app).get("/scim/v2/Users")).status).toBe(401);
    expect((await request(app).get("/scim/v2/Users").set("Authorization", "Bearer nope")).status).toBe(401);
  });
});

describe("SCIM Users", () => {
  it("creates a user and lists it with a valid token", async () => {
    const app = appWith(store);
    const created = await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "alice",
      name: { givenName: "Alice", familyName: "A" },
      emails: [{ value: "alice@example.com", primary: true }],
      roles: [{ value: "developer" }],
    });
    expect(created.status).toBe(201);
    expect(created.body.userName).toBe("alice");
    expect(created.body.active).toBe(true);
    expect(created.body.roles[0].value).toBe("developer");

    const list = await request(app).get("/scim/v2/Users").set("Authorization", AUTH);
    expect(list.body.totalResults).toBe(1);
    expect(list.body.Resources[0].emails[0].value).toBe("alice@example.com");
  });

  it("filters by userName and by email", async () => {
    const app = appWith(store);
    await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "bob", emails: [{ value: "bob@example.com" }] });
    const byName = await request(app).get('/scim/v2/Users?filter=userName eq "bob"').set("Authorization", AUTH);
    expect(byName.body.totalResults).toBe(1);
    const byEmail = await request(app).get('/scim/v2/Users?filter=emails.value eq "nobody@x.y"').set("Authorization", AUTH);
    expect(byEmail.body.totalResults).toBe(0);
  });

  it("PATCH active=false deactivates; DELETE also deprovisions", async () => {
    const app = appWith(store);
    const c = await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "carol", emails: [{ value: "carol@example.com" }] });
    const id = c.body.id as string;
    const patched = await request(app).patch(`/scim/v2/Users/${id}`).set("Authorization", AUTH).send({ Operations: [{ op: "replace", path: "active", value: false }] });
    expect(patched.body.active).toBe(false);
    const del = await request(app).delete(`/scim/v2/Users/${id}`).set("Authorization", AUTH);
    expect(del.status).toBe(204);
    expect(store.users.find((u) => u.id === id)?.active).toBe(false);
  });

  it("PUT updates the role", async () => {
    const app = appWith(store);
    const c = await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "dave", emails: [{ value: "dave@example.com" }] });
    const put = await request(app).put(`/scim/v2/Users/${c.body.id}`).set("Authorization", AUTH).send({ userName: "dave", emails: [{ value: "dave@example.com" }], roles: [{ value: "admin" }], active: true });
    expect(put.body.roles[0].value).toBe("admin");
  });

  it("enforces the seat cap on create", async () => {
    const app = appWith(store, { maxSeats: 1 });
    await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "one", emails: [{ value: "one@example.com" }] });
    const second = await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "two", emails: [{ value: "two@example.com" }] });
    expect(second.status).toBe(403);
    expect(second.body.detail).toContain("seat limit");
  });

  it("409s a duplicate email", async () => {
    const app = appWith(store);
    await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "e", emails: [{ value: "e@example.com" }] });
    const dup = await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "e2", emails: [{ value: "e@example.com" }] });
    expect(dup.status).toBe(409);
  });
});

describe("SCIM Groups", () => {
  it("projects roles as read-only groups", async () => {
    const app = appWith(store);
    await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "g1", emails: [{ value: "g1@example.com" }], roles: [{ value: "admin" }] });
    await request(app).post("/scim/v2/Users").set("Authorization", AUTH).send({ userName: "g2", emails: [{ value: "g2@example.com" }], roles: [{ value: "admin" }] });
    const groups = await request(app).get("/scim/v2/Groups").set("Authorization", AUTH);
    expect(groups.body.totalResults).toBe(1);
    expect(groups.body.Resources[0].displayName).toBe("admin");
    expect(groups.body.Resources[0].members).toHaveLength(2);
  });
});
