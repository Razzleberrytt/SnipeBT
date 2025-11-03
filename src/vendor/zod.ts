import { opt } from "./resolve";
import { z as zlite } from "./zod-lite";
const real = opt<any>("zod");
export const z = real?.z ?? real ?? zlite;
