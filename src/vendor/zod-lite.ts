type Any = any;
function makeNum(){ const o:any={ int:()=>o, min:()=>o, max:()=>o, default:(d:number)=>({_def:d,_t:"num"}), }; return o; }
function makeBool(){ const o:any={ default:(d:boolean)=>({ _def:d,_t:"bool"})}; return o; }
function makeStr(){ const o:any={ url:()=>o, default:(d:string)=>({ _def:d,_t:"str"}), optional:()=>({ _opt:true,_t:"str"}), }; return o; }
export const z:any = {
  object:(shape:Record<string,Any>)=>(
    {
      _shape: shape,
      safeParse(env:Record<string,any>){
        const out:Record<string,any> = {};
        for (const [k,def] of Object.entries(shape)){
          const v = (env as any)[k];
          if (def && typeof def==="object" && "_def" in (def as any)){
            out[k] = v ?? (def as any)._def;
          } else { out[k] = v; }
        }
        return { success:true, data:out };
      }
    }
  ),
  enum:(vals:string[])=>({ default:(d:string)=>({ _def:d,_t:"enum"}) }),
  coerce:{ number:()=>makeNum(), boolean:()=>makeBool() },
  string:()=>makeStr(),
};
