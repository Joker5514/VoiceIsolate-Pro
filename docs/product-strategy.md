# Conqueror Studios product strategy

**Decision document · August 2026**

## Executive decision

Conqueror Studios should stop presenting four unrelated products as one immediate
platform promise. The strongest initial business is a **hosted, observable agent
runner for small engineering teams**: define a constrained agent, connect an
approved tool set, run it through Nexus, and inspect a durable trace. The public
R&D lab and portfolio remain valuable as proof of expertise, but they should feed
one commercial conversion path rather than compete with it.

This recommendation is based on the repository as it exists today. It already
contains authentication, agent CRUD, Nexus execution, run history, traces,
provider routing, a waitlist, and partial Stripe integration. The fastest path to
validated revenue is to make that narrow loop reliable and sell design-partner
pilots before building a broad marketplace, autonomous agent network, consumer
apps, or a generalized multi-provider platform.

---

## 1. Improved version of the idea

### Product thesis

> **Conqueror Agent Studio helps small AI teams ship auditable agents without
> building orchestration and observability infrastructure.** Teams configure an
> agent, grant an explicit tool allowlist, test it against real tasks, and review
> the result, latency, cost, and trace before promoting a version.

### Target customer and job

- **Primary buyer:** technical founder, AI lead, or product engineering lead at a
  5–100 person software or services company.
- **Initial use case:** a bounded internal workflow with human review, such as
  research synthesis, support triage, document intake, or repository analysis.
- **Core job:** “Let me prove this agent is reliable, understand why it failed,
  and control its tools and spend before I expose it to customers.”
- **Not the first customer:** consumers seeking counseling, relationship
  analysis, or audio editing. Those require different brands, risk controls,
  distribution, and product teams.

### End-to-end experience

1. A visitor sees one promise, one short product proof, and one **Apply for a
   pilot** action.
2. After approval, the user signs in by magic link and enters a workspace.
3. A guided setup creates an agent from one of three templates or from scratch.
4. The user selects a supported model and explicitly grants tools. “No tools”
   means no tools, rather than implicitly granting every tool.
5. The user runs a test, sees streamed output, and receives a normalized trace
   containing model, tool calls, duration, token usage, estimated cost, and
   terminal status.
6. The user marks the result pass/fail, adds a note, and compares it with earlier
   versions.
7. An owner can set monthly run/spend limits and invite teammates. Production API
   access comes only after the interactive workflow is proven.

### Commercial promise

Do not sell “more agents.” Sell **faster validation, controlled execution, and
evidence**. The differentiator is a Git-native configuration and evaluation
history coupled with Nexus traces—not the number of model logos.

---

## 2. Key problems identified

### Positioning and product scope

1. **The identity changes by page.** The repository describes an independent R&D
   lab, a multi-tenant agent platform, a control plane, and a portfolio of
   consumer and developer products. A customer cannot quickly determine what is
   purchasable now.
2. **The flagship set is too broad.** Agent orchestration, an AI counselor,
   relationship analysis, and voice isolation have little shared buyer or buying
   motion. Cross-selling is unlikely at this stage.
3. **Claims exceed the visible evidence.** Terms such as “production-ready,”
   “best-in-class,” deterministic, and Git-native need benchmarks, public evals,
   architecture evidence, or customer results.
4. **The primary homepage action says “Deploy agent” but links to the project
   portfolio.** This breaks the action promise and makes the funnel ambiguous.
5. **The README is materially stale.** It says the site uses vanilla JavaScript
   with no build step, while the current application is Next.js, React, Supabase,
   React Query, Bun, and Stripe. This weakens contributor and operator trust.

### Workflow and UX

1. Agent creation exposes implementation concepts before explaining the user
   outcome; templates exist in code, but onboarding is not framed around a
   complete first success.
2. A run is useful, but there is no explicit test assertion, pass/fail feedback,
   evaluation set, version snapshot, cost budget, or promotion gate. Run history
   alone is observability, not validation.
3. Empty tool selection currently means all tools are allowed. That is surprising
   and unsafe; the secure default should be no tool access.
4. Billing has subscription synchronization and a customer portal, but there is
   no complete acquisition-to-checkout path, entitlement enforcement, usage
   metering, or plan definition.
5. “Owner console” and customer agent studio share `/console`, increasing the
   chance that lab administration and tenant product UX become coupled.

### Architecture and operations

1. The web app, gateway, Nexus, Bridge, Supabase, Stripe, and Postmark form a
   distributed system without a documented reliability model or end-to-end
   correlation standard.
2. Agent execution happens inside a request lifecycle. Long jobs, disconnects,
   retries, and serverless time limits can leave `running` rows behind or produce
   duplicate work.
3. Run payloads and full traces are stored in the primary database without a
   retention policy, redaction policy, size limit, or archival tier.
4. Several inputs need strict bounds and schemas, including agent names, prompts,
   models, tool identifiers, Nexus context, pagination values, and run input.
5. In-process IP limiting is neither globally consistent on serverless instances
   nor sufficient for tenant quotas and cost control.
6. The generic AI gateway uses one shared secret. That is acceptable for a
   controlled server-to-server prototype, not tenant authentication, per-key
   revocation, attribution, or billing.

### Security and trust

1. Nexus and Bridge URLs stay server-side, which is good, but service-to-service
   calls shown here do not authenticate the web app to Nexus. Network reachability
   should not imply authorization.
2. Prompt and trace data may contain secrets, personal data, or prompt-injection
   payloads. The product lacks a declared classification, redaction, retention,
   deletion, and export policy.
3. Tool allowlists must be enforced by Nexus/Bridge at execution time. Treating a
   UI field or request context as enforcement creates a confused-deputy risk.
4. Upstream calls need explicit connect/overall timeouts, cancellation behavior,
   response-size limits, and safe retry semantics.
5. Stripe webhook failures are logged while the handler can still acknowledge an
   event. Without durable event records and idempotent processing, billing state
   can silently drift.
6. Administrative API authorization must be role-based at every endpoint; a page
   redirect or email allowlist in a layout is not a sufficient API boundary.
7. Consumer mental-health and relationship-analysis products introduce elevated
   safety, privacy, age, claims, and escalation obligations. They should remain
   separate experiments until reviewed with domain and legal experts.

---

## 3. Recommended improvements

Priority labels: **P0 required before a paid pilot**, **P1 required for a strong
MVP**, and **P2 optional after validation**.

| Priority | Improvement | Why it matters |
|---|---|---|
| P0 | Choose one ICP and one use case; rewrite the homepage around Agent Studio | Makes the product understandable and the funnel measurable |
| P0 | Make tool access deny-by-default and enforce it downstream | Prevents accidental privilege expansion |
| P0 | Add workspace membership and server-side roles (`owner`, `admin`, `member`, `viewer`) | Creates a real multi-tenant boundary |
| P0 | Add tenant quotas for runs, concurrency, tokens, and spend | Limits abuse and unbounded provider cost |
| P0 | Authenticate web→Nexus and web→Bridge with rotated service credentials or workload identity | Establishes zero-trust service boundaries |
| P0 | Bound inputs, execution duration, response size, and retained trace size | Controls denial-of-service and storage risks |
| P0 | Define data retention, redaction, deletion, and incident procedures | Required to handle customer prompts credibly |
| P1 | Guided first-run flow with three outcome-based templates | Reduces time-to-value and setup ambiguity |
| P1 | Snapshot immutable agent versions on every run | Makes results reproducible and comparisons meaningful |
| P1 | Add pass/fail, expected outcome, notes, and a small eval suite | Converts traces into a reliability workflow |
| P1 | Normalize trace events and show latency, tokens, estimated cost, tools, and errors | Delivers the core product promise |
| P1 | Complete checkout, entitlement checks, usage ledger, and webhook reconciliation | Makes revenue and access control reliable |
| P1 | Replace portfolio claims with measured proof and status labels | Builds trust and avoids overstating maturity |
| P1 | Update operator and contributor documentation | Reduces deployment errors and maintenance cost |
| P2 | GitHub sync for agent definitions and eval fixtures | Deepens the Git-native advantage after workflow validation |
| P2 | Team invitations, SSO, audit export, and longer retention | Supports larger contracts after demand exists |
| P2 | Model routing recommendations and automatic fallback | Useful only after enough trace and eval data exists |
| P2 | Marketplace or cross-tenant agent sharing | High governance burden; defer until repeat usage exists |

### UX simplification

Use four primary product navigation items: **Agents, Runs, Evaluations, Settings**.
Move waitlist administration to a separate owner-only route or internal tool.
Keep the public portfolio under **Research**, with clear maturity labels:
`concept`, `prototype`, `private alpha`, `pilot`, or `generally available`.

Every screen should answer one question:

- **Agents:** what is configured and what can it access?
- **Runs:** what happened and why?
- **Evaluations:** is the current version better and safe to promote?
- **Settings:** who has access, what are the limits, and what will this cost?

### Revenue and durable advantage

Start with a **paid design-partner pilot**, not self-serve freemium:

- 4–6 week pilot, one workflow, onboarding and eval design included.
- Fixed setup fee plus a monthly platform fee and metered provider usage.
- Suggested pricing experiment: $1,500–$5,000 setup and $500–$2,000/month,
  adjusted after interviews—not published as a commitment.
- Convert repeat implementation work into templates and evaluation packs.

After 5–10 active teams demonstrate weekly retention, introduce a self-serve
developer tier and a team tier with seats, retention, and higher quotas. Enterprise
features—SSO, regional processing, private networking, custom retention, and SLA—
should be sold only when demanded.

The defensible assets are accumulated eval fixtures, normalized cross-provider
traces, failure taxonomies, Git review workflows, and integration expertise.
Provider aggregation alone is easily copied and carries weak margins.

---

## 4. Simplest strong MVP

### Include

1. Magic-link authentication and one workspace per initial account.
2. Agent CRUD with name, goal, system instruction, approved model, and explicit
   tool allowlist.
3. Three templates for bounded workflows; each includes sample input and expected
   output criteria.
4. Synchronous or streamed test runs with a hard timeout and cancellation.
5. Immutable run record containing the exact agent version, input, output,
   normalized trace, latency, token usage, estimated cost, status, and error code.
6. Human pass/fail rating and note.
7. A single evaluation set of up to 20 cases, run manually against a selected
   version, with pass rate and cost summary.
8. Workspace quota and kill switch.
9. Owner-visible usage and failures, plus a support/contact path.
10. Paid pilot entitlement managed manually at first, with Stripe used for
    invoicing or a single recurring plan only when it saves operational work.

### Explicitly exclude

- Public agent marketplace or community discovery.
- Autonomous agent-to-agent economy.
- Visual workflow builder.
- Arbitrary user-supplied MCP servers.
- Automatic model optimization or “quantum-inspired” routing claims.
- Mobile apps, voice interaction, counseling, and relationship analysis.
- Enterprise SSO, SCIM, on-premises deployment, and custom regions.
- A general public gateway API.

### MVP activation event

A user has activated when, within one session, they create an agent from a
template, complete a run, inspect its trace, and mark the result pass or fail.

---

## 5. Recommended technical approach

### Keep the current foundation

Retain Next.js, React, React Query, Supabase, Bun, Tailwind, and the Nexus/Bridge
service boundary. Do not rewrite or merge all services. The current stack is
adequate for pilots if boundaries and failure handling are strengthened.

### Domain model

Add these core entities:

- `workspaces` and `workspace_members`: tenant identity and roles.
- `agent_versions`: immutable configuration snapshots with content hash.
- `run_requests`: idempotency key, requested version, status, quota reservation,
  and timestamps.
- `run_events`: normalized append-only events; store large/raw payloads in object
  storage and keep references in Postgres.
- `evaluations`, `evaluation_cases`, and `evaluation_results`.
- `usage_ledger`: append-only tokens, provider cost, billable units, and source.
- `webhook_events`: Stripe event ID, processing status, attempts, and error.

Every tenant-owned row should carry `workspace_id`; RLS policies should be based
on membership, and service-role operations should repeat an explicit workspace
ownership check before writes.

### Execution lifecycle

1. Validate the request with a shared schema and check membership, entitlement,
   concurrency, and budget.
2. Create a run request using a client idempotency key and reserve quota.
3. Snapshot or reference the immutable agent version.
4. For short pilot runs, call Nexus with an authenticated signed request, hard
   deadline, correlation ID, and bounded payload. Move to a durable queue when
   measured duration or reliability requires it.
5. Nexus resolves the tool allowlist against a server-owned registry and checks
   authorization again before every tool call.
6. Emit a normalized event envelope: `event_id`, `run_id`, `workspace_id`,
   `sequence`, `type`, `occurred_at`, `safe_payload`, and `schema_version`.
7. Finalize usage and release unused quota atomically. A reconciliation job marks
   abandoned runs and repairs ledger discrepancies.

### API and frontend

- Continue placing browser server-state access behind React Query hooks.
- Use runtime schemas at every route boundary and return a consistent error
  envelope with safe error codes.
- Prefer cursor pagination for run/event history.
- Stream through a documented SSE event schema; do not infer streaming from
  `Transfer-Encoding: chunked`.
- Support cancellation with `AbortSignal`, but make cancellation idempotent.
- Never render raw trace HTML. Redact secrets before persistence and escape all
  user/model content at display time.
- Add cache controls appropriate to sensitive data (`private, no-store`).

### Security baseline

- Replace shared tenant gateway secrets with hashed, scoped API keys that have an
  ID, workspace, scopes, expiry, last-used timestamp, and revocation.
- Store provider credentials in a managed secret store; log identifiers, never
  values. Prefer platform-owned keys for the first pilot rather than browser BYOK.
- Add distributed rate and concurrency limiting backed by Redis or the selected
  queue/store before opening access broadly.
- Apply CSRF/origin protection to cookie-authenticated mutations, and use strict
  security headers and a Content Security Policy.
- Create automated authorization tests for cross-workspace reads/writes and each
  role. Test RLS and application checks independently.
- Separate product analytics from prompt/trace content. Default analytics events
  to metadata only and provide deletion/export workflows.
- Record administrative actions in a tamper-evident audit log.

### Reliability and maintenance

- Define service-level indicators: successful run rate, queue delay, first-token
  latency, total latency, trace persistence success, and billing reconciliation.
- Use one correlation ID through the edge, web app, Nexus, Bridge, and tool call.
- Pin trace and API schemas; support additive evolution and contract tests.
- Add a run sweeper, dead-letter handling, webhook replay, database backups, and
  restore drills.
- Maintain a single environment-variable reference and deployment runbook.

---

## 6. Alternative approaches with trade-offs

| Approach | Advantages | Trade-offs | Recommendation |
|---|---|---|---|
| **A. Hosted Agent Studio** | Reuses most current code; clear recurring value; creates trace/eval data moat | Requires orchestration reliability and strong tenant security | **Recommended** |
| **B. Services-first AI lab** | Fastest revenue; founder expertise is the product; little platform polish needed | Less scalable, key-person risk, custom work can fragment roadmap | Use paid pilots as the go-to-market wrapper for A |
| **C. Open-source Nexus + paid control plane** | Developer trust, distribution, self-hosting path | Documentation/support burden; hard to monetize before adoption | Revisit after a stable hosted workflow and external contributors |
| **D. Multi-provider gateway API** | Simple developer story and broad market | Commodity category, thin margins, provider/platform competition, abuse risk | Keep internal; do not lead positioning |
| **E. VoiceIsolate as standalone product** | Clearer single-purpose utility; potentially consumer/creator distribution | Different stack, buyer, support model, and benchmark burden | Spin out only with verified audio-quality advantage |
| **F. AI Counselor / relationship products** | Large consumer interest and emotional engagement | Highest safety, regulatory, claims, privacy, and brand risk | Do not include in the platform MVP |

---

## 7. Implementation roadmap

### Phase 0 — Decide and validate (weeks 0–2)

- Conduct 12–15 interviews with the primary ICP; require evidence of a current
  workflow, failure cost, decision process, and budget.
- Select one use case and recruit three design partners.
- Rewrite the product promise and funnel; label all portfolio projects by actual
  maturity.
- Define the threat model, data inventory, retention defaults, and pilot terms.
- Establish baseline funnel and application telemetry without recording prompts.

**Exit:** three partners agree to provide tasks/data and at least one accepts a
paid pilot proposal.

### Phase 1 — Secure the core (weeks 2–5)

- Add workspaces, memberships, roles, and authorization tests.
- Change tools to deny-by-default and enforce grants within Nexus/Bridge.
- Add signed service authentication, strict schemas, input limits, deadlines,
  response caps, distributed limits, and cost quotas.
- Add immutable agent versions and a stable run/event schema.
- Add retention/redaction and abandoned-run reconciliation.

**Exit:** cross-tenant tests pass; threat-model P0 items close; repeated runs do
not create duplicate charges or permanently running records.

### Phase 2 — Deliver the MVP loop (weeks 5–8)

- Ship guided templates, sample task, streamed run, trace summary, pass/fail, and
  notes.
- Add the 20-case manual evaluation workflow and version comparison.
- Add usage dashboard, kill switch, operator alerts, and support workflow.
- Run accessibility and mobile/responsive reviews on the full onboarding path.

**Exit:** a new partner completes the activation loop without live assistance;
the team can diagnose failures from telemetry alone.

### Phase 3 — Paid pilots (weeks 8–12)

- Onboard three partners one at a time and hold weekly outcome reviews.
- Add the minimum checkout/invoice, entitlement, webhook ledger, and
  reconciliation needed for those contracts.
- Measure reliability, customer time saved, failure rate, gross margin, and
  weekly retained use. Remove features that are not used.

**Exit:** at least two partners use the product weekly for four consecutive weeks,
one renews or expands, and provider plus infrastructure cost supports the target
margin.

### Phase 4 — Productize (after evidence)

- Turn repeated pilot setup into templates and evaluation packs.
- Add GitHub synchronization, team invitations, API keys, and async execution in
  the order customers demand them.
- Publish measured case studies and eval methodology.
- Consider self-serve pricing only after support load and unit economics are
  understood.

---

## 8. Risks and assumptions

| Risk or assumption | Consequence | Mitigation / validation |
|---|---|---|
| Teams value traceability enough to pay | Core positioning fails if they only want cheaper inference | Price-test during interviews and require a paid pilot |
| Nexus is reliable under real workloads | Run UX and customer trust depend on it | Load, soak, timeout, cancellation, and fault-injection tests |
| Git-native workflow is differentiated | Could add complexity without user benefit | Start with immutable versions; build Git sync only after demand |
| Founder can support pilots | Services load may crowd out product work | Fixed scope, capped partners, office hours, reusable templates |
| Provider costs remain predictable | Gross margin can collapse on long prompts/tools | Reservations, hard budgets, cost ledger, model allowlist |
| Trace storage grows rapidly | Database cost and query performance degrade | Payload caps, redaction, tiered object storage, retention policy |
| Tool integrations expand attack surface | Prompt injection can cause harmful side effects | Read-only tools first, least privilege, confirmation gates, sandboxing |
| Magic links meet customer security needs | Larger teams may require stronger controls | Short sessions, MFA roadmap, SSO only for contracted demand |
| Third-party service availability is adequate | Multiple dependencies amplify outages | Circuit breakers, clear status, fallbacks only where semantically safe |
| Product claims create trust | Unsupported claims can do the opposite | Publish reproducible metrics and precise maturity labels |

The roadmap assumes one small implementation team, a functioning Nexus and Bridge
environment, and access to Supabase, model-provider, Stripe, and email credentials.
If Nexus is not sufficiently stable, sell services-first pilots and use manual
execution while hardening it rather than masking failures in the UI.

---

## 9. Testing and success criteria

### Product and UX

- Five representative users can explain the product and intended buyer after
  viewing the homepage for 10 seconds; target: **4/5 correct**.
- Pilot users can complete sign-in → template → first run → trace → rating without
  assistance; target: **80% completion** and **under 10 minutes median**.
- Accessibility: automated checks plus keyboard and screen-reader review of auth,
  agent creation, run, trace, evaluation, billing, and destructive actions;
  target: **WCAG 2.2 AA** for the core path.
- Responsive checks at 320 px, 768 px, and desktop widths with no inaccessible
  controls or clipped trace content.

### Functional and contract testing

- Unit tests for schemas, quotas, costs, redaction, role decisions, and event
  normalization.
- Route integration tests for success, invalid input, unauthenticated requests,
  wrong workspace, quota exhaustion, timeouts, cancellation, provider errors,
  and replayed idempotency keys.
- Database tests for every RLS policy, including a matrix of roles and attempts to
  read or mutate another workspace.
- Nexus/Bridge contract tests pinned to schema versions, including malformed,
  oversized, reordered, duplicated, and interrupted stream events.
- Stripe tests with signed fixtures, duplicates, out-of-order events, processing
  failures, and reconciliation.

### Security and reliability

- Automated secret scanning, dependency audit, SAST, and authorization regression
  tests on every pull request.
- Prompt-injection exercises against every tool; no tool outside the effective
  allowlist executes, and risky write actions require explicit confirmation.
- Load test at 2× expected pilot peak and soak test for two hours; no quota bypass,
  unbounded memory growth, or unexplained stuck runs.
- Restore drill and webhook replay test before billing customers.
- Targets during pilot: **≥99% platform-attributable run completion**, **zero
  cross-tenant data exposure**, **zero unbounded-cost incidents**, and **≥99.9%
  trace finalization**. Provider failures should be reported separately.

### Business outcomes

- Phase 0: 12–15 interviews, three qualified design partners, one paid commitment.
- Activation: ≥60% of approved accounts reach the MVP activation event within
  seven days.
- Retention: at least two of the first three partners perform a meaningful run in
  each of four consecutive weeks.
- Value: each renewing partner documents either ≥5 hours/month saved or a
  measurable improvement in workflow quality/reliability.
- Economics: target **≥70% gross margin before founder services time**, then price
  onboarding separately until implementation becomes repeatable.
- Trust: no P0 security incidents and all deletion/export requests completed
  within the published window.

---

## 10. Final recommendation

Proceed, but narrow aggressively. Treat Conqueror Studios as the credibility and
research brand, and make Agent Studio the only product being actively sold for the
next 90 days. Use paid, tightly scoped design-partner engagements to discover the
repeatable workflow. Build the smallest credible loop—versioned agent, explicit
tools, run, trace, evaluation, and quota—and harden tenant and service boundaries
before opening it broadly.

Do **not** invest next in a marketplace, autonomous economy, generalized gateway,
or additional consumer products. If the team cannot secure one paid pilot after
15 well-qualified interviews and three tailored demonstrations, pause platform
expansion and reposition around services or a narrower standalone product. If it
can secure and retain pilots, invest in Git synchronization and reusable eval
packs: those best reinforce the product's stated philosophy and create an
advantage that compounds with real usage.
