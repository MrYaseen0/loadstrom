# MOTIVE.md — Why Strom Fire Exists

---

## The problem

Every developer who runs a website eventually asks the same question:

> **"Can my site handle it?"**

Before a product launch, a marketing campaign, or a traffic spike from a viral post, you need to know whether your server will hold up — or crumble at the first wave of real visitors.

The existing solutions were:

- **Paid SaaS tools** (Loader.io, Blitz.io, k6 Cloud) — require subscription, cloud dependency, and sending your URL to a third party
- **Complex open-source tools** (k6, Locust, Gatling) — steep learning curve, multiple dependencies, JVM/Python runtime overhead
- **DIY scripts** — fragile, hard to maintain, no dashboard, no verdict

None of these matched what a solo developer with a personal site actually needed:

> **Something free, simple, self-hosted, and honest — that tells you in plain language whether your own site can take the hit.**

---

## The motivation

Strom Fire was built because:

1. **Zero cost** — The creator (Yaseen Ahmad) runs personal projects on free-tier hosting. Paying for load-testing SaaS on top of that makes no sense. If the tool costs money, it defeats the purpose of testing whether your free-tier site can handle traffic.

2. **Zero dependencies** — No `npm install`, no Docker, no Python runtime. Just `node server.js`. Works offline. No supply-chain risk. One process, full control.

3. **Privacy** — Load testing sends massive traffic to your target. You shouldn't have to route that through a third-party cloud service. The tool runs entirely on your machine, targeting only what you own.

4. **Simplicity** — The question "can my site handle it?" should have a simple answer: PASS, WARN, or FAIL. No complex configuration files, no SLO definitions, no dashboards within dashboards. Paste URL, set users, start.

5. **Personal ownership** — This tool exists for Yaseen Ahmad's own projects and sites ([yaseenahmadexe.vercel.app](https://yaseenahmadexe.vercel.app/) and others). It was built to test *his* infrastructure, then shared because the same problem every developer faces.

6. **Legal clarity** — The tool is deliberately designed to only work against sites you own. The confirmation gate, blocklist, and documentation all reinforce: **test your own things only.**

---

## What Strom Fire was NOT built for

- ❌ **Distributed cloud load generation** — This is a single-machine tool. (Future: JSON reports designed to be merged.)
- ❌ **Third-party penetration testing** — Blocklist and SSRF guards prevent testing sites you don't own.
- ❌ **Production monitoring** — This is a testing tool, not an observability platform.
- ❌ **Replacing k6/Locust at enterprise scale** — One Node process hits ~2,200 rps locally. That's plenty for personal sites and staging.

---

## Design philosophy

| Principle | Why |
|---|---|
| **Free and open** | If you can't afford load testing, you shouldn't be blocked from knowing your site works |
| **Self-hosted** | Your traffic stays on your machine. No data leaves. |
| **Zero deps** | `node server.js` and it's done. No `npm install` that fails, no supply chain, no version conflicts. |
| **Verdict-first** | The output is a clear PASS/WARN/FAIL. Not raw data you have to interpret. |
| **Defensive by default** | Auto-abort, blocklists, confirmation gates — the tool protects you from breaking things you didn't mean to break. |
| **Anonymity optional** | Tor integration for when you need to test without exposing your identity or IP. |

---

## Who this is for

- Solo developers with personal projects on Vercel, Netlify, Railway, etc.
- Students learning about system performance
- Anyone who has ever had a site go down because they didn't test before launch
- Privacy-conscious operators who refuse to route traffic through third-party SaaS
- People running free-tier infrastructure who can't afford paid load-testing tools

---

## The name

**Strom Fire** — *Strom* (German for "current/stream/power") + *Fire* (the intensity of a load test).

When you hit start, you're sending a current of requests at your server. The fire is the intensity. The verdict tells you whether it survives.

---

*Built by Yaseen Ahmad for testing his own infrastructure and sharing with developers who need a free, honest answer to: "Can my site handle it?"*
