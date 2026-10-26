# nexus-ai-pro Roadmap

What comes next, and why: only work that has not shipped. This is a design proposal, not a
compatibility promise. What is stable and what is experimental, and what a surface must show to
graduate, is defined in [API_STABILITY.md](./API_STABILITY.md); what has shipped is in
[CHANGELOG.md](./CHANGELOG.md); how releases are planned is in [CONTRIBUTING.md](./CONTRIBUTING.md).
Work leaves this page when it ships.

Current release: **2.20.2**.

---

## Open gaps

Each gap is written down in a guide's limitations today, and each is closed by one release: 2.21, or
the theme after it that owns it.

| Gap | Where it shows | Closed in |
| --- | --- | --- |
| The Pinecone store has passed its graduation checks only against a stand-in | API stability | 2.21 |
| Images have not recorded live conformance on all three backends | API stability | 2.21 |
| The Gemini embedding batch tier has not run against Gemini | Embeddings guide | 2.21 |
| Media understanding has not passed its conformance suite against a vision model and the OCR service | Media guide | 2.21 |
| Video generation has not passed its conformance suite against Gemini Omni Flash, Veo, and Runway | Video guide | 2.21 |
| Gemini Live and SIP calls have been verified against their protocols, not against the live services | Realtime guide | 2.21 |
| Calls and messages have been verified against stand-ins for Twilio's and Telnyx's APIs | Telephony guide | 2.21 |
| Typed decisions have passed against a stand-in of TypeSafe AI's API, not the live service | Decisions guide | 2.21 |

---

## 2.21.0: Decisions about pictures, and compatibility records from community CI

**Carried: live graduation.** The Pinecone store, images, the Gemini embedding batch tier, media
understanding, video, typed decisions, Gemini Live, SIP call control, and both phone providers
graduate when the scheduled live workflow passes against each, published with their checklists. Every
check runs there now; what stands in the way is the repository's live credentials, and for video, the
variable that lets it spend seconds of video.

**Decisions about pictures.** A typed decision is asked of text or JSON today. 2.21 asks it of the
pictures a state holds too: a yes or no, a choice, or a score about an image, and where in a picture
something is, as a box, from TypeSafe AI's Jev and from any vision model, with the media family's
inputs and the same confidence and calibration.

**Compatibility records from community CI.** A community adapter's record reaches the compatibility
page by a pull request today. 2.21 has an adapter publish its own record from its own CI, sealed as
`nexus adapters verify` seals it, and a scheduled workflow gathers the records onto the page, turning
an adapter red when its record says it no longer passes.

**Proof.** One decision suite passes on pictures, on TypeSafe AI's API against a stand-in written from
its documentation and on a vision model, a box landing where the picture has it; and a record an
adapter's CI publishes reaches the page with nothing merged, and a failing one turns it red.

---

## Unscheduled

Nothing else is placed yet.

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
