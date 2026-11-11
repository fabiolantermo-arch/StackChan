// Temporary local expression: no provider calls, no memory writes, no motor commands.
export class TouchReaction {
  constructor(){this.until=0;this.last=-Infinity;}
  accept(source,event,now=Date.now()){
    if(source!=='screen' && !(source==='head' && ['press','forwardSwipe','backwardSwipe'].includes(event?.gesture)))return false;
    if(now-this.last<450)return false;
    this.last=now;this.until=now+3000;return true;
  }
  apply(state,now=Date.now()){
    return now<this.until?{...state,emotion:3}:state;
  }
  clear(){this.until=0;this.last=-Infinity;}
}
