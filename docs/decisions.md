# Typed decisions

<!-- covers: ./decisions ./decisions/typesafe ./decisions/mock -->

Software asks a model many small questions it then acts on: which team takes a ticket, whether a
message is an attack, how well an answer meets a rubric. A decision, from `nexus-ai-pro/decisions`, is
such a question asked as a type: a yes or no, a choice among options, a score on a rubric, or where
something is in a picture, about one state, text, JSON, or the pictures it holds. Each answer comes back
with its probabilities, or its box, and a confidence, so the application acts on it without parsing
text, and knows when not to.

```ts
import { NexusAI } from 'nexus-ai-pro';
import { completionDecisions, DecisionManager, gate } from 'nexus-ai-pro/decisions';
import { TypeSafeDecisionProvider } from 'nexus-ai-pro/decisions/typesafe';

const ai = new NexusAI({ providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } });
const decisions = new DecisionManager(
  {
    providers: {
      jev: new TypeSafeDecisionProvider({ apiKey: process.env.TYPESAFE_API_KEY! }),
      gpt: completionDecisions(ai, { model: 'gpt-4.1-mini' }),
    },
    fallbacks: ['gpt'],
  },
  { lifecycle: ai.lifecycle },
);

const { answers } = await decisions.decide({
  state: ticket,
  questions: {
    team: { type: 'choice', options: { billing: 'Charges and invoices', technical: 'Errors and outages' } },
    urgent: { type: 'yes-no', question: 'Does the customer need an answer today?' },
    severity: { type: 'score', levels: ['Cosmetic', 'Degraded', 'Blocking'] },
  },
});
if (gate(answers.team, { act: 0.8 }) === 'act') route(answers.team.choice); // 'billing' | 'technical'
```

## Questions and answers

A `DecisionRequest` holds a `DecisionState`, text or any JSON value, and `DecisionQuestions`: each a
`DecisionQuestion` under the name its answer comes back by, asked in isolation against the same state.
A `DecisionQuestionType` is one of four:

| Question | What it asks | Its answer |
| --- | --- | --- |
| `YesNoQuestion` | A yes or no, with `criteria` for what counts as each | A `YesNoAnswer`: `yes`, its `probability`, and `confidence` |
| `ChoiceQuestion` | One of its `options`, by name, with what each means, up to 255 | A `ChoiceAnswer`: the `choice`, every option's `probabilities`, and `confidence` |
| `ScoreQuestion` | A level of its `levels`, lowest first, two to ten | A `ScoreAnswer`: the weighted `score`, the most probable `level`, each level's `probabilities`, and `confidence` |
| `BoxQuestion` | Where something is in a picture the state holds, its `question` naming the picture | A `BoxAnswer`: the `box`, a `DecisionBox`, and `confidence` |

The answers are typed by their questions: `AnswerOf` gives a question's `DecisionAnswer`, and
`DecisionAnswers` the whole set, so a choice's answer names only its own options, and a misspelt one
fails to compile. A request also names its `provider` and `model`, its `tenantId`, a `signal`,
`metadata` for the trace, and `cache: false` to ask afresh. A `DecisionResult` holds the answers, the
`provider` and `model` that gave them, its `DecisionUsage`, its `cost`, how long it took, and whether
it was `cached`.

Confidence is read from the probabilities the same way whichever provider gave them, as TypeSafe AI
documents it for its own:
- `yesNoConfidence()`: how far the probability is from an even chance, `|2p - 1|`;
- `choiceConfidence()`: how far the top probability is above an even split, `(pmax - 1/n) / (1 - 1/n)`;
- `scoreConfidence()`: one less the probability-weighted distance from the most probable level, over
  that distance for an even spread, and 0 at an even spread or wider.

Confidence is a margin, not a probability: a yes at 0.75 has confidence 0.5. `answerProbability()` is
the probability an answer gives its own answer, which is what calibration compares with accuracy.

## Decisions about pictures

A state that is an object or a list may hold pictures anywhere in it: image parts,
`{ type: 'image', source }`, held as bytes, base64, a file, a URL, or an asset, and the assets an image
operation returns. A question names each by its path in backticks, `photo`, `faces.happy`, or
`frames[2].frame`, and every question type may ask about one.

```ts
import { readFile } from 'node:fs/promises';

const photo = { type: 'image', source: { buffer: await readFile('claims/7.jpg'), mimeType: 'image/jpeg' } } as const;
const { answers } = await decisions.decide({
  state: { claim: 'Water damage to the kitchen door', photo },
  questions: {
    damaged: { type: 'yes-no', question: 'Does `photo` show damage to a door?' },
    where: { type: 'box', question: 'the damage in `photo`' },
  },
});
if (answers.damaged.yes && gate(answers.where, { act: 0.7 }) === 'act') crop(answers.where.box);
```

A box question always gets a box, even for something the picture does not show, so ask a yes or no
beside it, as above. A `DecisionBox` has four edges, each a fraction from 0 to 1 of the picture's
height or width from its top-left corner; an answer whose edges fall outside that, or cross, is refused
as malformed. `boxOverlap()` measures how far two boxes overlap, the area they share over the area they
cover together, and `answeredRight()` counts a box right when it overlaps the expected one by half or
more, or by its `overlap` option. A box has no probabilities, so its confidence stands in for one, and
`calibrate()` chooses a threshold for boxes as it does for any answer.

The manager refuses a picture that is the whole state, which no path names, and a box asked of a state
with no picture. A provider declares `DecisionProviderCapabilities.images` when it reads pictures; one
that does not is refused a decision about a picture, and passed over as a fallback. A picture is never
written into a trace or a cache key: both hold a digest of its bytes, or its path or URL, in its place.
The budget holds each picture at 1,600 tokens, what one within 1,568 pixels a side costs at most, and
never reads its base64 as text.

`statePictures()` lists a state's pictures, each a `DecisionPicture` with its path, and `readPicture()`
reads one into a `ReadDecisionPicture`, with its bytes, its MIME type as its bytes say, and its size, by
the media family's readers: a file only with `readFile`, a URL only with `fetch`, and a stored asset
from an asset store. A picture it cannot read, or whose bytes are not an image, fails the decision,
naming its path.

## Gates and calibration

`gate()` turns a confidence into a `GateOutcome`: `act` at or above `GateThresholds.act`, `review` (a
person decides) at or above `review`, and `abstain` below. Thresholds belong to the risk of what the
answer does: a low bar to route a ticket, a high one to refund an order.

Choose them from data. `calibrate()` takes `CalibrationSample` values, each an answer and whether it
was right, as `answeredRight()` reads it, and returns a `CalibrationReport`:
- `expectedCalibrationError`, the gap between the probability answers gave themselves and how often
  they were right, from the `CalibrationBin` ranges it counts in;
- with `CalibrateOptions.targetAccuracy`, the `threshold`: the lowest confidence at which the answers
  at or above it hold the target, keeping at least `minSamples`, and the `coverage` it acts on.

```ts
const samples = labelled.map(({ answer, expected }) => ({ answer, correct: answeredRight(answer, expected) }));
const { threshold, coverage } = calibrate(samples, { targetAccuracy: 0.95, minSamples: 100 });
```

A model whose confidence runs high is chosen a higher threshold, and the threshold holds on answers
like the ones it was chosen from, not on a different kind of question or state.

## The manager

`DecisionManager` sends each request to the provider it names, the `DecisionConfig.defaultProvider`,
or the first registered, and checks it first: a malformed question, or one the provider cannot take,
is refused with a `DecisionError` before anything is sent. Its `DecisionErrorCode` is
`DECISION_INVALID`, `DECISION_UNSUPPORTED`, `DECISION_NO_PROVIDER`, or `DECISION_FAILED`, and
`retryable` says whether another provider may help. `fallbacks` are asked in order when one is: a
timeout, a refused connection, or an overloaded service, never a malformed request or a refused key.
`registerDecisionProvider()`, `hasDecisionProvider()`, and `listDecisionProviders()` manage providers
by name, and `decide()` asks one provider with none of this.

`DecisionConfig.cache` keeps each decision's answers in any cache adapter, the memory, Redis, or SQLite
one, as `CachedDecision` values, so the same questions about the same state, for the same tenant, are
answered once. `prices` add `DecisionPrice` rates, per million tokens, to `DECISION_PRICES`, which holds
TypeSafe AI's published price for Jev, $42 per billion input tokens with output free, and
`priceDecision()` prices a decision's usage, leaving one without a price unpriced, never free.

`DecisionRuntime.lifecycle` runs every decision as an operation of the client, family `decision`:
authorized, rate limited, audited, on the tenant's own key, and held against the budget at its model's
price before it is sent. `DecisionRuntime.tracer` records each one as a run of kind `decision`, with its
answers, usage, and cost, and the provider's own calls nested beneath; `DecisionTracerLike` and
`DecisionRunLike` are the parts of a tracer it uses.

## Providers

`TypeSafeDecisionProvider`, from `nexus-ai-pro/decisions/typesafe`, speaks TypeSafe AI's System One API,
`POST /v1/systemone`. Its model, Jev (`jev-latest`, `jev-preview`, or a version), answers only typed
questions, all of a decision in one call, each in isolation, with no text to parse.
`TypeSafeDecisionProviderOptions` sets the `apiKey`, a `baseUrl` (a proxy that passes the API through
works), the `model`, `longContext`, which sends the header TypeSafe AI requires for a long state,
`media`, the readers for pictures held by reference, a `timeoutMs` (30 seconds), `headers`, and a
`fetch`. A refusal of a field names it, from the API's validation error, and a 400 or 413 is a refused
decision, not a failure to try again; `listModels()` reads `GET /v1/models`.

The pictures a state holds go to Jev as the API's assets, each under a new reference in its place in
the state, with the `TypeSafe-Danger-Zone-Images` header that pictures and boxes require. TypeSafe AI
takes a still PNG or JPEG of at most 16 MiB, from 280 to 1,568 pixels a side, in a request of at most
32 MiB, and refuses one outside them rather than resize it, so the adapter refuses it first, naming its
path, before anything is sent. A box needs Jev 1.14 or later, which `jev-latest` serves; a decision
asking one of an earlier version is refused as unsupported.

`completionDecisions()` makes any completion model a provider, through a client's own `complete()`, so
every call is routed, budgeted, traced, and priced as every completion is. Each question is asked on its
own, at temperature 0, to answer with one code: a letter per option, Y or N, or a level's digit. Its
probabilities are read from the log probabilities of that token's alternatives, on a provider that
reports them; elsewhere it is asked `samples` times and each answer counted.
`CompletionDecisionsOptions.method`, a `CompletionDecisionMethod`, is `logprobs`, `sampling`, or `auto`,
the default, which samples a model that reports none or refuses them, and remembers it. A
`DecisionCompletionClient` is anything with `complete()`, such as `NexusAI`. Its calls are charged
where they are made, so its decisions charge nothing again.

A vision model is shown the pictures a state holds: the state's text with each picture's place marked,
then each picture labelled by its path, then the question. A box is asked `samples` times at the
sampling temperature, and is the median of each edge; its confidence is how far the samples overlap
that box, a sample with no box agreeing with nothing, and `method: 'logprobs'` refuses one. Set
`images: false` for a text-only model, which takes no box and no picture.

`MockDecisionProvider`, from `nexus-ai-pro/decisions/mock`, answers as `MockDecisionProviderOptions.answer`
says, or with an even spread, and keeps every request it was asked.

A provider of your own implements `DecisionProvider`: `decide()` takes a `DecisionProviderRequest`, its
model, state, and each `DecisionProviderQuestion`, and a `DecisionCallContext`, and returns a
`DecisionProviderResult` of each question's `DecisionDistribution`. The manager reads every answer from
those with `decisionAnswer()`, so confidence is the same everywhere. Its `DecisionProviderInfo` names it
and declares its `DecisionProviderCapabilities`: the question types, options, levels, and questions it
takes, whether it reads pictures, and its default model. Its state holds the pictures themselves, for
`statePictures()` and `readPicture()`, and a box comes back as `{ type: 'box', box, confidence }`.

## Decisions where the package decides

Each takes a `DecisionManagerLike`, such as a `DecisionManager`, and `DecisionRequestOptions` for whom
and what to ask:

| Function | Where it decides | What an uncertain answer does |
| --- | --- | --- |
| `decisionRoute()` | A graph's branch, for `addConditionalEdges()`, by a choice whose options name nodes, or by `routes` | Goes to `review`, such as a node that asks a person with `interrupt()` |
| `decisionPermissions()` | An agent's tool calls, after a `base` policy: what it allows or refuses stands | Still asks a person |
| `decisionGuard()` | Agent middleware asking a yes or no of each message and each answer: a confident yes stops it | Waits for a person, who answers a `DecisionGuardReview` |
| `decisionModel()` | Agent middleware sending each turn to a model by a choice about its message, every call of the turn | Keeps the agent's own model |
| `decisionEvaluator()` | A judge's score, with the answer's confidence in its metadata | Goes to people with `reviewUnsure()`, as online evaluation's `reviewWhen` |

`DecisionRouteOptions`, `DecisionPermissionsOptions`, `DecisionGuardOptions`, `DecisionModelOptions`, and
`DecisionEvaluatorOptions` set each one's question, threshold, and state. An evaluator may ask a box,
and given `where` the thing is, such as from the example's expected output, scores how far the box
overlaps it, passing at `overlap`, one half by default. `classifyRoute()`, from the
workflows, takes `decisions` too, and then answers with every label's probability.

## Conformance

`runDecisionConformance()` checks any provider against the contract and lists what fails, as a
`DecisionConformanceReport`: its capabilities are coherent, each question type it declares comes back
as probabilities, or a box, that fit, a provider that reads pictures answers about one, several
questions in one decision each get their own answer, a stopped call is not answered, and each
`DecisionConformanceCase` of `DecisionConformanceOptions.cases`, a question whose answer is known, is
answered right; a case's `expected` may be a box. The checks of pictures and boxes need a `picture`;
without one they are listed as `skipped`, not passed.

In the test suite, one decision suite passes on TypeSafe AI's API, against a stand-in written from its
documentation, on a model's log probabilities, and on sampling. On 2,000 labelled invoices, the
threshold a calibration chooses holds its accuracy on 2,000 it never saw, for a calibrated model and for
an overconfident one, where a threshold taken on trust does not. A support graph routes tickets by
decision, and every ticket it is unsure of reaches a person. One decision suite about pictures, of yes
or no, choice, score, and box cases, passes on TypeSafe AI's API, against a stand-in that checks its
documented asset rules and looks at the pixels, and on a vision model, with each box landing where the
picture has it; a model that reads only the text fails it.

## Limitations

- The family is experimental until the live workflow passes against TypeSafe AI's Jev and a model that
  reports log probabilities.
- Confidence is only as calibrated as the model is; choose thresholds from the application's own
  labelled answers, and choose them again when the model or the questions change.
- A completion model's decision costs a call per question, or `samples` calls where it reports no log
  probabilities, and sampled probabilities come in steps of one sample. A choice of more than 20 options
  is sampled.
- TypeSafe AI marks pictures, boxes, and its long-context mode as experimental, and their request
  format and limits may change between its releases.
- A completion model's box costs `samples` calls, and its confidence is how far they agree, not a
  probability the model gave it.
- The adapter does not resize a picture TypeSafe AI would refuse, nor send pictures as multipart parts;
  a decision's pictures travel as base64 within the 32 MiB a request may hold.
- Jev is in early access; its adapter has passed against a stand-in written from TypeSafe AI's
  documentation, not yet against the live service.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/decisions`

| Export | Kind | Summary |
| --- | --- | --- |
| `answeredRight` | function | Whether an answer is right: a yes-or-no or a choice by its answer, a score by its most probable level, or by its weighted score within `tolerance` levels when one is given, and a box by how far it overlaps the expected one, `boxOverlap()`, at least `overlap` (one half by default). |
| `AnswerOf` | type | The answer a question gets: a choice's answer names only its options. |
| `answerProbability` | function | The probability an answer gives its own answer: a yes or no's `max(p, 1 - p)`, a choice's for its option, and a score's for its level. |
| `BoxAnswer` | interface | A box question's answer. |
| `boxOverlap` | function | How far two boxes overlap, from 0 to 1: the area they share over the area they cover together, the intersection over union by which a box is judged against where the thing is. |
| `BoxQuestion` | interface | A question answered with where something is in a picture of the state: a box around it. |
| `CachedDecision` | interface | A decision's answers as the cache keeps them. |
| `calibrate` | function | Measures how well answers' probabilities track how often they are right, and, with `targetAccuracy`, chooses the gate threshold that holds it. |
| `CalibrateOptions` | interface | Options for `calibrate()`. |
| `CalibrationBin` | interface | Answers that gave their own answer a probability in one range, and how often they were right. |
| `CalibrationReport` | interface | How well answers' probabilities tracked how often they were right, and the threshold that holds the target. |
| `CalibrationSample` | interface | One answer whose right answer is known, and whether it was right. |
| `ChoiceAnswer` | interface | A choice question's answer. |
| `choiceConfidence` | function | A choice's confidence, from its options' probabilities: how far the top one is above an even split, `(pmax - 1/n) / (1 - 1/n)`. |
| `ChoiceQuestion` | interface | A question answered by one of its options, with each option's probability. |
| `CompletionDecisionMethod` | type | How a completion model's probabilities are read. |
| `completionDecisions` | function | Any completion model as a decision provider, through a client's own `complete()`, so every call is routed, authorized, budgeted, traced, and priced as every completion is. |
| `CompletionDecisionsOptions` | interface | Options for `completionDecisions()`. |
| `decide` | function | Answers a decision with one provider, outside any manager: no failover, cache, or lifecycle. |
| `DECISION_PRICES` | constant | Bundled decision prices, by model name or a prefix of it: TypeSafe AI's Jev at its published price, $42 per billion input tokens, with output free, as of 2026-10-24. |
| `decisionAnswer` | function | An answer from a provider's probabilities for one question: normalized to sum to 1, with its confidence read the same way whichever provider gave them. |
| `DecisionAnswer` | type | Any answer. |
| `DecisionAnswers` | type | Answers by their questions' names, each typed by its question. |
| `DecisionBox` | interface | Where something is in a picture: each edge a fraction, from 0 to 1, of the picture's height (`top`, `bottom`) or width (`left`, `right`), measured from its top-left corner. |
| `DecisionCallContext` | interface | What every decision call receives: how to stop, the request's id, and the tenant's credential. |
| `DecisionCompletionClient` | interface | Anything that completes a request, such as a `NexusAI` client. |
| `DecisionConfig` | interface | Configuration for `DecisionManager`. |
| `DecisionConformanceCase` | interface | A question whose right answer is known, for `runDecisionConformance()`. |
| `DecisionConformanceOptions` | interface | Options for `runDecisionConformance()`. |
| `DecisionConformanceReport` | interface | How a provider did against the decision contract. |
| `DecisionDistribution` | type | A provider's probabilities for one question, from which the answer and its confidence are read. |
| `DecisionError` | class | Raised for a decision no provider can serve, a question that is malformed, or a provider's failure. |
| `DecisionErrorCode` | type | Why a decision failed. |
| `decisionEvaluator` | function | An evaluator that asks a decision: the score is the probability of yes, the score's level as a share of the top one, the passing option's probability, or how far a box overlaps where the thing is, and its metadata carries the answer's confidence and probabilities, or its box, so an uncertain score can go to people with `reviewUnsure()`. |
| `DecisionEvaluatorOptions` | interface | Options for `decisionEvaluator()`. |
| `decisionGuard` | function | Agent middleware that guards each message and answer with a yes-or-no decision, such as whether a message is a prompt injection or an answer leaks what it must not. |
| `DecisionGuardOptions` | interface | Options for `decisionGuard()`. |
| `DecisionGuardReview` | interface | What a person answers when a guard is unsure: let it pass, or not. |
| `DecisionManager` | class | Decisions behind one handle: each goes to the provider named, the default, or the first registered, with failover to `fallbacks`, a cache, and every call inside a client's lifecycle. |
| `DecisionManagerLike` | interface | Anything that answers decisions, such as a `DecisionManager`. |
| `decisionModel` | function | Agent middleware that sends each turn to a model by a decision about the user's message: a quick question to a fast model, a hard one to a strong one. |
| `DecisionModelOptions` | interface | Options for `decisionModel()`. |
| `decisionPermissions` | function | A permission policy that asks a decision where a person would otherwise be asked: a confident yes runs the call, a confident no refuses it, and anything less still asks the person. |
| `DecisionPermissionsOptions` | interface | Options for `decisionPermissions()`. |
| `DecisionPicture` | interface | A picture in a decision's state, and where it is. |
| `DecisionPrice` | interface | A decision model's price, in US dollars per million tokens. |
| `DecisionProvider` | interface | A backend that answers decisions: a decision model, a completion model, or a stand-in. |
| `DecisionProviderCapabilities` | interface | What a decision provider takes. |
| `DecisionProviderInfo` | interface | Identifies a decision provider and what it takes. |
| `DecisionProviderQuestion` | type | A question as a provider receives it: a choice's options in order, each with its description. |
| `DecisionProviderRequest` | interface | What a provider is asked. |
| `DecisionProviderResult` | interface | What a provider answers. |
| `DecisionQuestion` | type | Any question. |
| `DecisionQuestions` | type | Questions by the names their answers come back under. |
| `DecisionQuestionType` | type | The kinds of question there are: a yes or no, a choice among options, a score on levels, or a box around something in a picture. |
| `DecisionRequest` | interface | A decision: questions about one state, answered together and each in isolation. |
| `DecisionRequestOptions` | type | The parts of a decision request an integration takes from the application: whom and what to ask. |
| `DecisionResult` | interface | A decision's answers, and who gave them. |
| `decisionRoute` | function | A graph router that asks a decision, for `addConditionalEdges()`: a confident answer goes to its node, and an uncertain one to `review`, where a person can answer instead. |
| `DecisionRouteOptions` | interface | Options for `decisionRoute()`. |
| `DecisionRunLike` | interface | A decision's run in a trace, as decisions finish it. |
| `DecisionRuntime` | interface | What the manager runs on. |
| `DecisionState` | type | What every question of a decision is about: text, or any JSON value. |
| `DecisionTracerLike` | interface | A tracer, or the part of one decisions use: a run per decision, with the provider's calls inside it. |
| `DecisionUsage` | interface | What a decision used, where the provider reports it. |
| `gate` | function | Turns an answer's confidence into what to do: act at or above `act`, have a person review it at or above `review`, and abstain below. |
| `GateOutcome` | type | What to do with an answer: act on it, have a person review it, or neither. |
| `GateThresholds` | interface | The confidences a gate acts at, and has reviewed at. |
| `priceDecision` | function | What a decision cost, from its usage and the model's price; `undefined` for a model without a price or usage without tokens, never zero. |
| `ReadDecisionPicture` | interface | A picture's bytes, read for a provider that sends them. |
| `readPicture` | function | Reads a picture's bytes, with the media family's readers: bytes and base64 as they are, a file with `readFile`, a URL with `fetch`, and a stored asset from `assets`. |
| `reviewUnsure` | function | A `reviewWhen` for online evaluation that sends a run to people when any of its decision scores, or the one `key` names, is less sure than `threshold`. |
| `runDecisionConformance` | function | Checks a provider against the decision contract: its capabilities are coherent; each question type it declares comes back as probabilities, or a box, that fit the question; a provider that reads pictures answers about one; several questions in one decision each get their own answer; a stopped call is not answered; and every case is answered right. |
| `ScoreAnswer` | interface | A score question's answer. |
| `scoreConfidence` | function | A score's confidence, from its levels' probabilities: one less the probability-weighted distance from the most probable level, over that distance for an even spread, and 0 at an even spread or wider. |
| `ScoreQuestion` | interface | A question answered on an ordered rubric: level 0 first, with each level's probability. |
| `statePictures` | function | Every picture in a state, in the order they appear, each with its path. |
| `YesNoAnswer` | interface | A yes-or-no question's answer. |
| `yesNoConfidence` | function | A yes-or-no answer's confidence: how far its probability is from an even chance, `\|2p - 1\|`. |
| `YesNoQuestion` | interface | A question answered yes or no, with the probability that it is yes. |

### `nexus-ai-pro/decisions/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockDecisionProvider` | class | Answers decisions as `answer` says, without a model, and keeps every request it was asked in `requests`. |
| `MockDecisionProviderOptions` | interface | Options for `MockDecisionProvider`. |

### `nexus-ai-pro/decisions/typesafe`

| Export | Kind | Summary |
| --- | --- | --- |
| `TypeSafeDecisionProvider` | class | TypeSafe AI's System One API (`POST /v1/systemone`): Jev, a model that answers only typed questions, a yes or no ("noul"), a choice among up to 255 options, a score on up to ten levels, or a box around something in a picture, and bills for input tokens alone. |
| `TypeSafeDecisionProviderOptions` | interface | Options for `TypeSafeDecisionProvider`. |
<!-- reference:end -->
