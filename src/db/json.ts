import fs from "fs"; import path from "path";
type TradeRow = { id:string; position_id:string|null; side:"BUY"|"SELL"; mint:string; price:number; size:number; tx_sig:string|null; route:string|null; fee_lamports:number|null; created_at:number; };
export class JsonDB {
  private file:string; private state:{ trades: TradeRow[] } = { trades: [] };
  constructor(dir:string){ if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); this.file=path.join(dir,"state.json"); if (fs.existsSync(this.file)) this.state=JSON.parse(fs.readFileSync(this.file,"utf8")); }
  insertTrade(t:TradeRow){ this.state.trades.push(t); fs.writeFileSync(this.file, JSON.stringify(this.state,null,2)); }
}
