/**
 * Who a request, a run, or a tool call is for.
 *
 * One shape everywhere: the server's authentication hook returns it, a run carries it, graph nodes
 * and workflow steps read it, tools and middleware receive it, and a permission policy can decide on
 * it. Its tenant scopes threads, runs, budgets, and the store.
 */
export interface Principal {
  /** Isolates threads, runs, and cron jobs. Requests only ever see their own tenant's resources. */
  tenantId?: string;
  /** Who the caller is: a token's subject, a key's owner. Recorded on what they create. */
  userId?: string;
  /** What the caller may do. A route that names a scope refuses a principal without it. */
  scopes?: readonly string[];
  /** The caller's roles, for policies and tools that decide by role rather than by scope. */
  roles?: readonly string[];
  /** How the caller was authenticated: `jwt`, `api-key`, `proxy`, or a name of your own. */
  method?: string;
  /** The verified claims or attributes the principal was built from, for anything the fields above leave out. */
  claims?: Readonly<Record<string, unknown>>;
}
