# Getting Started

Choose the guide that matches how you want to run BrowserOS.

## Quickstart — Local (no Docker)

Run a single-user BOS instance on your own machine. Hot-reload, no containers, no auth layer.

**You need:** Node 20, Git, an Anthropic API key.

→ [quickstart.md](./quickstart.md)

---

## Docker + Simple Auth

Deploy a multi-user BOS stack with Docker Compose. Users log in with a username and password managed by the bastion.

**You need:** Docker Engine 24+, Docker Compose v2, Git.

→ [docker-simple-auth.md](./docker-simple-auth.md)

---

## Docker + Keycloak (OAuth / SSO)

Same multi-user Docker stack, but authentication is delegated to a Keycloak OIDC provider. A pre-configured realm export is included for a fast start; the guide also covers manual Keycloak setup.

**You need:** Docker Engine 24+, Docker Compose v2, Git (and optionally an existing Keycloak instance).

→ [docker-keycloak.md](./docker-keycloak.md)

---

## After getting started

| Goal | Where to look                                                                    |
|------|----------------------------------------------------------------------------------|
| Use the assistant, apps, and desktop | [docs/usage/](../introduction.md)                                                |
| Build or install apps | [docs/usage/building-and-modifying/](../building-and-modifying/building-apps.md) |
| Extend BOS / contribute code | [docs/dev/architecture-overview.md](../../dev/architecture-overview.md)          |
| Full deployment reference | [docs/dev/deployment.md](../dev/deployment.md)                                   |
