export type CommandHandler = (ctx: { reply(text: string): void }) => void;
export class Telegraf {
  constructor(token: string);
  command(name: string, handler: CommandHandler): void;
  launch(): void;
  stop(): void;
}
