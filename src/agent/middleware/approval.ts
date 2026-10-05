import { isSensitiveCapability } from '../capabilities.js';
import type { AgentApproval, AgentMiddleware, AgentMiddlewareContext, AgentToolCall } from '../create-agent.js';

/** Options for `humanApproval()`. */
export interface HumanApprovalOptions {
  /**
   * Which calls need a person's approval. Defaults to every call whose tool declares nothing, or
   * declares a capability that does anything but read.
   */
  when?: (call: AgentToolCall, context: AgentMiddlewareContext) => boolean;
  /** The question a person sees. Defaults to naming the tool and its arguments. */
  reason?: (call: AgentToolCall) => string;
  /**
   * Asks out of band instead of suspending the run: posts to a chat and waits for the answer, or
   * applies a rule of your own. Without it, the run suspends through `interrupt()` until `resume()`
   * answers, as `interruptOn` does.
   */
  approve?: (call: AgentToolCall, context: AgentMiddlewareContext) => AgentApproval | Promise<AgentApproval>;
}

/**
 * Asks a person before a tool call runs, decided per call rather than per tool name.
 *
 * `interruptOn` approves every call to a named tool; this approves the calls a rule picks: a refund
 * over a limit, a write outside a draft folder, anything a tool does that is not a read. An
 * approver may refuse, or correct the arguments, which the permission policy then decides again.
 * Put it before `toolRetry()`, so a retried call is not asked about twice.
 */
export function humanApproval(options: HumanApprovalOptions = {}): AgentMiddleware {
  const when =
    options.when ??
    ((call: AgentToolCall) => call.capabilities === undefined || call.capabilities.some(isSensitiveCapability));
  const reason =
    options.reason ?? ((call: AgentToolCall) => `Run tool "${call.name}" with ${JSON.stringify(call.args)}?`);
  return {
    name: 'human-approval',
    async wrapToolCall(call, next, context) {
      if (!when(call, context)) return next();
      const answer = options.approve
        ? await options.approve(call, context)
        : context.interrupt<AgentApproval>({ reason: reason(call), payload: call });
      if (answer === false || (typeof answer === 'object' && !answer.approved)) {
        const why = typeof answer === 'object' && !answer.approved ? answer.reason : undefined;
        return { ok: false, error: why ?? 'A person refused this tool call' };
      }
      return typeof answer === 'object' && answer.approved && answer.args
        ? next({ ...call, args: answer.args })
        : next();
    },
  };
}
