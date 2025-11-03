import { opt } from "./resolve";
const real = opt<any>("prom-client");
const fallback = {
  Counter: class { private v=0; inc(n=1){ this.v+=n; } },
  register: { contentType: "text/plain; charset=utf-8", async metrics(){ return "# offline prom-client stub\\n"; } },
  collectDefaultMetrics: () => {}
};
const client = real ?? fallback;
export default client;
