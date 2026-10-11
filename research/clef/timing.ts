/** An interrupted repeated protocol must not silently pool its available tail. */
export function timingRows<T extends {status:string;round:number;timingSample?:boolean}>(rows:T[],phase:string,amended:boolean):T[] {
  return rows.filter(r=>r.status==='completed'&&(amended?r.round===0:phase==='pilot'||r.timingSample));
}
