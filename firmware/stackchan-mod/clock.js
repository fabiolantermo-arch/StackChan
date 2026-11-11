// Extend the SDK's wrapping millisecond counter into a relative monotonic clock.
export class MotionClock {
  constructor(read,delta){this.read=read;this.delta=delta;this.previous=read();this.elapsed=0;this.valid=Number.isFinite(this.previous);}
  now(){
    if(!this.valid)return NaN;
    const current=this.read(),step=this.delta(this.previous,current);
    if(!Number.isFinite(current)||!Number.isFinite(step)||step<0){this.valid=false;return NaN;}
    this.previous=current;this.elapsed+=step;return this.elapsed;
  }
}

// Italian time (owner's request, 9 Nov 2026): UTC+1, and summer time (+1 hour) from the last Sunday of March to
// the last Sunday of October, both at 01:00 UTC, as in the whole European Union.
const lastSunday=(year,month)=>{const last=new Date(Date.UTC(year,month+1,0));return Date.UTC(year,month,last.getUTCDate()-last.getUTCDay(),1);};
export function italianSummerTime(utcMs){const year=new Date(utcMs).getUTCFullYear();return utcMs>=lastSunday(year,2)&&utcMs<lastSunday(year,9);}
export const ITALY_OFFSET=3600; // seconds, winter time
