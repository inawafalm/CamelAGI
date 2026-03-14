// CLI command registry — replaces brittle if-else chain with a simple map

export interface CliCommand {
  name: string;
  description: string;
  usage?: string;
  run: (args: string[]) => Promise<void>;
}

const commands = new Map<string, CliCommand>();

export function register(cmd: CliCommand): void {
  commands.set(cmd.name, cmd);
}

export function resolve(name: string): CliCommand | undefined {
  return commands.get(name);
}

export function allCommands(): CliCommand[] {
  return Array.from(commands.values());
}

export function isRegistered(name: string): boolean {
  return commands.has(name);
}
