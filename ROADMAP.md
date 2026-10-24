# nexus-ai-pro Roadmap

What comes next, and why: only work that has not shipped. This is a design proposal, not a
compatibility promise. What is stable and what is experimental, and what a surface must show to
graduate, is defined in [API_STABILITY.md](./API_STABILITY.md); what has shipped is in
[CHANGELOG.md](./CHANGELOG.md); how releases are planned is in [CONTRIBUTING.md](./CONTRIBUTING.md).
Work leaves this page when it ships.

Current release: **2.19.0**.

---

## Open gaps

Each gap is written down in a guide's limitations today, and each is closed by one release: 2.20, or
the theme after it that owns it.

| Gap | Where it shows | Closed in |
| --- | --- | --- |
| The Pinecone store has passed its graduation checks only against a stand-in | API stability | 2.20 |
| Images have not recorded live conformance on all three backends | API stability | 2.20 |
| The Gemini embedding batch tier has not run against Gemini | Embeddings guide | 2.20 |
| Media understanding has not passed its conformance suite against a vision model and the OCR service | Media guide | 2.20 |
| Video generation has not passed its conformance suite against Gemini Omni Flash, Veo, and Runway | Video guide | 2.20 |
| Gemini Live and SIP calls have been verified against their protocols, not against the live services | Realtime guide | 2.20 |
| Calls and messages have been verified against stand-ins for Twilio's and Telnyx's APIs | Telephony guide | 2.20 |
| Typed decisions have passed against a stand-in of TypeSafe AI's API, not the live service | Decisions guide | 2.20 |
| An emulated tool is one the application defined; a service's API description is not read into tools | Evaluation guide | 2.20 |
| An emulator holds what one run did, not what a whole evaluation did | Evaluation guide | 2.20 |

---

## 2.20.0: Tools emulated from an API description, and an emulator that remembers the evaluation

**Carried: live graduation.** The Pinecone store, images, the Gemini embedding batch tier, media
understanding, video, typed decisions, Gemini Live, SIP call control, and both phone providers
graduate when the scheduled live workflow passes against each, published with their checklists. Every
check runs there now; what stands in the way is the repository's live credentials, and for video, the
variable that lets it spend seconds of video.

**Tools from an API description.** An emulated tool is one the application defined today. 2.20 reads
a service's own API description, an OpenAPI document, into tools whose names, parameters, and answers
are the service's, so an agent is evaluated against a service before it is wired to it, with nothing
sent.

**An emulator that remembers the evaluation.** An emulator holds what one run did; the next run starts
again from its scenario. 2.20 lets it hold the world across a whole evaluation, so an order one example
refunds is refunded for the next, as a staging copy would have it, and lets each run start instead
from a snapshot of it.

**Proof.** An agent over tools read from a stand-in service's OpenAPI document reaches the verdict it
reaches over the stand-in itself, with nothing sent; and an evaluation whose examples build on each
other's changes reaches the stand-in's verdict, run in order and again from a snapshot.

---

## Unscheduled

Not yet placed, roughly in order of what applications ask for:

1. Decisions about images: where in a picture something is, and questions asked over the pictures a
   state holds, with the media family.
2. Compatibility records published from community adapters' own CI, gathered onto the page by a
   scheduled workflow rather than by pull request.
3. A2A requests routed by their tenant, and an agent card's security schemes and signatures read
   over gRPC.

**Held for 3.0.** Settings that 2.x keeps opt-in because turning them on changes what an upgrade
does. In 3.0 they become defaults, each with a migration note:
- incremental tracing on a persistent trace store;
- the Redis operation store's dispatch index;
- `hash-v2` bucketing for deployments created on 3.0. A deployment keeps the strategy it records.

**Deliberately not planned:** a hosted service, a large third-party integration catalogue (MCP and the
adapter kit cover breadth), and a second language runtime. Nor does the 2.x line prioritize more
completion providers, vector databases, or image providers, more domain workflow templates, or another
orchestration abstraction: a provider is worth carrying when it passes its conformance suite against
the live service every week.
