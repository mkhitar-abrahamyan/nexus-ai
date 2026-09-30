/**
 * The Nexus studio: a local UI for what a nexus-ai-pro application records.
 *
 * Traces with trees and diffs; threads with a live diagram, state, forks, edits, and resume; an
 * inbox for interrupts and review queues; datasets and experiment comparisons; prompts with diffs,
 * gated promotion, and a playground; costs against budgets; provider health and circuits; and the
 * operation queue; context bundles; issues and regressions found in traces; and proposed fixes. It
 * reads the application's own stores through their adapters and needs no hosted service: local and
 * token-only by default, or shared by a team with accounts, roles, an audit log, and comments.
 */
export { createStudio, SESSION_COOKIE, type Studio, StudioError, TOKEN_HEADER } from './api.js';
export {
  anyOf,
  type BearerAuthOptions,
  bearerAuth,
  csrfToken,
  type HeaderAuthOptions,
  hasRole,
  headerAuth,
  personalTokens,
  STUDIO_ROLES,
  type StudioAuthenticator,
  type StudioRequestInfo,
  type StudioRole,
  type StudioUser,
} from './auth.js';
export { loadConfig, loadSources, loadUsers, parseArgs } from './cli.js';
export {
  FileStudioJournal,
  MemoryStudioJournal,
  type MemoryStudioJournalOptions,
  type StudioAuditEntry,
  type StudioAuditLog,
  type StudioComment,
  type StudioCommentStore,
} from './journal.js';
export { type GraphLayout, type LaidOutEdge, type LaidOutNode, layoutGraph } from './layout.js';
export { createToken, hostAllowed, tokensMatch } from './security.js';
export { type RunningStudio, type StartStudioOptions, startStudio } from './server.js';
export type {
  StudioAssetStore,
  StudioBudget,
  StudioCheckpoint,
  StudioCircuitStore,
  StudioClient,
  StudioContextHub,
  StudioCostReport,
  StudioDeployments,
  StudioGraphLike,
  StudioGraphSource,
  StudioInterrupt,
  StudioOperationStore,
  StudioOptions,
  StudioPromptRegistry,
  StudioProposalInbox,
  StudioReviewQueue,
  StudioSources,
  StudioTenants,
} from './types.js';
