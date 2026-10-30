# nexus-ai-pro Roadmap

What comes next, and why: only work that has not shipped. This is a design proposal, not a
compatibility promise. What is stable and what is experimental, and what a surface must show to
graduate, is defined in [API_STABILITY.md](./API_STABILITY.md); what has shipped is in
[CHANGELOG.md](./CHANGELOG.md); how releases are planned is in [CONTRIBUTING.md](./CONTRIBUTING.md).
Work leaves this page when it ships.

Current release: **3.0.0**.

---

## Open gaps

Each gap is written down in a guide's limitations today, and each is closed by one release: 3.1, or
the theme after it that owns it.

| Gap | Where it shows | Closed in |
| --- | --- | --- |
| The Pinecone store has passed its graduation checks only against a stand-in | API stability | 3.1 |
| Images have not recorded live conformance on all three backends | API stability | 3.1 |
| The Gemini embedding batch tier has not run against Gemini | Embeddings guide | 3.1 |
| Media understanding has not passed its conformance suite against a vision model and the OCR service | Media guide | 3.1 |
| Video generation has not passed its conformance suite against Gemini Omni Flash, Veo, and Runway | Video guide | 3.1 |
| Gemini Live and SIP calls have been verified against their protocols, not against the live services | Realtime guide | 3.1 |
| Calls and messages have been verified against stand-ins for Twilio's and Telnyx's APIs | Telephony guide | 3.1 |
| Typed decisions have passed against a stand-in of TypeSafe AI's API, not the live service | Decisions guide | 3.1 |
| Gemini's voice has passed against a stand-in written from its API, not the live service | Voice guide | 3.1 |

---

## 3.1.0: Live graduation

**Carried: live graduation.** The Pinecone store, images, the Gemini embedding batch tier, media
understanding, video, typed decisions, Gemini Live, SIP call control, and both phone providers
graduate when the scheduled live workflow passes against each, published with their checklists. Every
check runs there now; what stands in the way is the repository's live credentials, and for video, the
variable that lets it spend seconds of video. Gemini's voice, experimental since 2.22, joins them: it
speaks a sentence there and hears it back.

Nothing else is placed in 3.1 yet: it takes the top of Unscheduled when something is placed there.

---

## Unscheduled

Nothing else is placed yet.

**Deliberately not planned:** a hosted service, a large third-party integration catalogue (MCP and the
adapter kit cover breadth), and a second language runtime. Nor does the 3.x line prioritize more
completion providers, vector databases, or image providers, more domain workflow templates, or another
orchestration abstraction: a provider is worth carrying when it passes its conformance suite against
the live service every week.
