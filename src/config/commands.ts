import { Command } from "./command_types";
import { boxCommands } from "./commands/box";
import { coreCommands } from "./commands/core";
import { personalCommands } from "./commands/personal";

/**
 * The full command surface.
 *
 * Deliberately small. A command earns a slot only when the model cannot or
 * should not make the call itself: Telegram protocol, an authorization
 * boundary, an explicit override of the router's decision, or control of work
 * already in flight. Everything else is either a tool the model already
 * carries or a Mini App tab, both of which are reachable without the user
 * memorising anything.
 */
export const commands: Command[] = [
  ...coreCommands,
  ...boxCommands,
  ...personalCommands,
];
