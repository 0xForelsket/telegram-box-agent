import { Command } from "./command_types";
import { boxCommands } from "./commands/box";
import { coreCommands } from "./commands/core";
import { personalCommands } from "./commands/personal";
import { utilitiesCommands } from "./commands/utilities";

export const commands: Command[] = [
  ...coreCommands,
  ...utilitiesCommands,
  ...boxCommands,
  ...personalCommands,
];
