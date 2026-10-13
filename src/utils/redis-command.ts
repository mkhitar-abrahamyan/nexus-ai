/**
 * Sending a raw Redis command through whichever client an application passes: ioredis's `call()`
 * or node-redis's `sendCommand()`. Kept apart so each Redis adapter decides the same way.
 */

/** A client that sends raw commands, as ioredis or node-redis does. */
export type RedisRawClient<Arg = string> =
  | { call(command: string, ...args: Arg[]): Promise<unknown> }
  | { sendCommand(args: Arg[]): Promise<unknown> };

/**
 * A function that sends one command as an array. `call` is used when a client has it: ioredis has a
 * `sendCommand()` too, which takes its own command object rather than an array.
 */
export function redisSender<Arg>(client: RedisRawClient<Arg>): (args: Arg[]) => Promise<unknown> {
  return 'call' in client
    ? (args) => client.call(args[0] as unknown as string, ...args.slice(1))
    : (args) => client.sendCommand(args);
}
