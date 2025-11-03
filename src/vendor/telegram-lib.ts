import { opt } from "./resolve";
const real = opt<any>("telegraf");
export const Telegraf = real?.Telegraf ?? real ?? class {
  constructor(..._args:any[]){/* no-op */}
  command(){/* no-op */}
  launch(){/* no-op */}
};
