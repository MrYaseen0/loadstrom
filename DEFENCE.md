# DEFENCE.md — Safety, Guardrails & Defensive Measures

Strom Fire is a **weapon-grade request generator**. The defensive measures in this document exist to ensure it is only ever pointed at systems you own, and that it stops before it can cause real damage.

---

## 1. Ownership confirmation gate

Every load test **must** be explicitly confirmed by the user.

| Layer | Enforcement |
|---|---|
| **UI** | Checkbox: "I own this target or have explicit written permission to load-test it." |
| **Server** | `confirm === true` required in `POST /api/start`. Without it → `400`. |
| **Blocklist** | `safety.js` hardblocks well-known third-party hosts (google.com, facebook.com, youtube.com, etc.) |
| **Documentation** | `readme.md` states ownership requirement clearly |

```js
// server.js: /api/start gate
if (body.confirm !== true) return next({ status: 400, error: 'Confirm ownership checkbox first.' });
```

**The UI checkbox is UX only. The server-side `confirm` check is the real defence.**

---

## 2. Third-party host blocklist

Known public sites that the tool **refuses** to target:

```js
const KNOWN_PUBLIC_HOSTS = [
  'google.com', 'www.google.com', 'bing.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'amazon.com', 'wikipedia.org', 'twitter.com', 'x.com',
  'linkedin.com', 'github.com', 'cloudflare.com', 'microsoft.com', 'apple.com',
  'netflix.com', 'reddit.com', 'tiktok.com', 'paypal.com', 'stripe.com',
  'openai.com', 'anthropic.com', 'baidu.com', 'yandex.com', 'whatsapp.com',
];
```

If you try to target any of these, the server returns:
> `${host} is a well-known third-party site. Strom Fire will not test domains you do not own.`

This is a **tripwire, not a complete firewall**. The list is deliberately small — it catches accidents, not deliberate misuse.

---

## 3. Auto-abort safety valve

If a target starts collapsing during a test, the tool **stops automatically**:

| Mode | Trigger | Action |
|---|---|---|
| **Normal** (no rotation) | ≥10% errors after 50 requests | Test stops immediately |
| **Auto-rotate** (Tor/proxy) | ≥50% errors after 500 requests | Test stops as extreme backstop |

```
_autoAbort() check loop:
  → Track error count in sliding window
  → If errors ≥ threshold% AND requests ≥ minimum window
  → Emit 'block-detected' event → auto-abort with reason
  → Report includes abortReason for post-mortem analysis
```

This prevents the tool from hammering a server that's already down.

---

## 4. SSRF protection (DNS rebinding guard)

### The threat
An attacker could supply a URL like `http://internal-service.local` that resolves to a private IP, tricking the tool into attacking internal infrastructure.

### The defence
`safety.js` runs two layers of validation:

1. **Synchronous** (`validateTarget`): Fast-path check for scheme, format, and blocklist
2. **Asynchronous** (`validateTargetResolved`): DNS resolution check — if a hostname resolves to a private/metadata IP, it's blocked

```
Policy:
  ✅ Literal private IP (192.168.x, 10.x, 127.x) → ALLOWED (user chose it explicitly)
  ✅ localhost / 127.0.0.1 → ALLOWED (demo target)
  ❌ Hostname resolving to private IP → BLOCKED (DNS rebinding)
  ❌ 169.254.169.254 (cloud metadata) → ALWAYS BLOCKED
  ❌ 0.0.0.0, ::, fe80:: → BLOCKED
```

---

## 5. Authentication & access control

| Feature | Implementation |
|---|---|
| **Sign-in** | One owner account, no registration page. Credentials set via env vars (`STROMFIRE_USER`, `STROMFIRE_PASSWORD`) |
| **Password storage** | scrypt hashing, verified per-boot with unique salt. Passwords never stored, logged, or returned |
| **Session** | Random server-side token in `HttpOnly` + `SameSite=Lax` cookie (12h expiry, sliding refresh, `Secure` over TLS) |
| **Error messages** | Generic: `Invalid username or password.` — no username enumeration |
| **Rate limiting** | 10 sign-in attempts/min per IP |
| **API access** | `LOADSTORM_TOKEN` for scripts/automation alongside session cookies |
| **Rate limiter** | 120 POST requests/min per IP on all API endpoints |
| **Open mode warning** | Without `STROMFIRE_PASSWORD`, server runs open (dev mode) and announces it at boot |

---

## 6. Auto-abort details (the valve anatomy)

The auto-abort valve is the **last line of defence** when everything else fails:

```
During test execution:
  → Each request result recorded (success / error)
  → Error rate calculated in sliding window
  → If error rate ≥ threshold:
      → Normal mode: abort after ≥ 50 requests
      → Auto-rotate mode: abort after ≥ 500 requests (rotation may recover transient blocks)
  → abortReason stored in report:
      "Aborted: error rate exceeded X% after N requests"
      "Despite N rotations" (if autoRotate was active)
```

**Default thresholds:**
- `abortOnErrorRatePct`: 10% (normal), 50% (auto-rotate extreme backstop)
- Minimum request window: 50 (normal), 500 (auto-rotate)

---

## 7. Request-level defences

| Defence | What it does |
|---|---|
| **Body size limit** | 64 KB max request body → `413` for oversized payloads |
| **Timeout** | Configurable per-request timeout (default 30s) |
| **Redirect limit** | Max 5 redirects (prevents redirect loops consuming resources) |
| **Connection pool cap** | `maxSockets` bounded per agent |
| **Metrics cap** | Reservoir sampler (200k max) prevents unbounded memory growth |
| **Timeline cap** | 256 samples per chart bucket, trimmed to 1200 buckets |
| **Rate limiter** | Per-IP 120 POST/min on all API endpoints |

---

## 8. Anonymity protections

When running through Tor:

| Protection | How |
|---|---|
| **Tor circuit rotation** | `autoRotate: true` triggers NEWNYM when error rate hits `blockThresholdPct` (70%) |
| **Header rotation** | `rotateHeaders: true` cycles through Chrome/Firefox/Safari profiles |
| **TLS fingerprint spoofing** | Per-profile cipher suites, curves, signature algorithms |
| **IP isolation** | Per-user cookie jars, sticky header profiles |
| **Evasion gate** | `ENABLE_EVASION=1` required for Tor rotation (opt-in, not default) |
| **Tor control port** | Verified via `pickControlPort` before rotation |

---

## 9. Network-level hardening

| Setting | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind to localhost only — not exposed to internet |
| `PORT` | 8787 | Configurable via env var |
| TLS | Self-signed dev cert | Replace with real cert if exposed |
| Reverse proxy | Not configured | Add Nginx/Caddy with TLS + auth if exposing |
| Firewall | Not configured | Block inbound 8787 from internet |

---

## 10. The complete defence chain

When you press START, here's what happens before a single request is fired:

```
1.  User checks "I own this target" checkbox          → UI consent
2.  POST /api/start with confirm: true                → Server-side consent gate
3.  validateTarget() — scheme, format, blocklist       → Block known third-party sites
4.  validateTargetResolved() — DNS resolution check    → Block SSRF/rebinding
5.  Rate limiter check (120/min per IP)               → DoS prevention
6.  Token/session verification                        → Auth check
7.  LoadEngine constructed with bounded resources     → Memory/connection caps
8.  Auto-abort valve armed                            → Fail-fast safety net
9.  Requests begin firing                             → Real load generation
10. Auto-abort monitors error rate in real time       → Stops if target collapses
```

---

## 11. What the defences CANNOT do

| Limitation | Mitigation |
|---|---|
| Blocklist is small | It's a tripwire, not a firewall. Read the warnings. |
| UI checkbox can be bypassed | Server-side `confirm` check is the real gate |
| Blocklist won't catch new sites | User must verify ownership |
| Tor rotation can be detected | Advanced adversaries may still fingerprint |
| Single-machine ceiling | ~2-5k concurrent users max. Horizontal scaling planned. |
| Legal compliance is user's responsibility | Tool provides guardrails, not legal advice |

---

## 12. Responsible use reminder

> **Strom Fire is for testing systems YOU OWN or are explicitly authorized to test.**
>
> The auto-abort valve, blocklist, and confirmation gate are guardrails — **they are not a substitute for your own judgement or written permission.**
>
> Unauthorized load testing can violate laws (CFAA, Computer Misuse Act, etc.) and terms of service.

---

*See `readme.md` for responsible use policy, `HARDENING_PLAYBOOK.md` for hardening your own Strom Fire instance, and `ANONYMITY_SETUP.md` for anonymous testing setup.*
