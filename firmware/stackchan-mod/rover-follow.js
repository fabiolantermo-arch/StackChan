// «Inseguimento con rover» (owner, 15 Nov 2026: «inizia a programmare il VL53L0X per potermi seguire, metti un
// interruttore nella scheda robot per inseguimento con rover»). PREPARED, NEVER TRIED WITH THE REAL ROVER OR SENSOR.
//
// The robot follows the owner with its whole body: the camera finds the face (the head follows it as always), the
// VL53L0X (tof-wire.js) says how far the person is. It is ON THE HEAD, as every sensor for now (owner, 23 Nov 2026:
// «i sensori per adesso sono tutti sulla testa»; written «on the front of the body» before the parts came): it looks
// where the head looks, up toward the face too. Each robot cycle this gives at most one
// short move, which the robot stops by itself (rover-wire.js):
//   - head turned toward the face by more than turnYaw: the body turns that way on the spot (the head, which keeps
//     following, comes back toward the middle); between straightYaw and turnYaw a shorter turn (nudgeMs), because the
//     distance sensor sees only what is in front of the body (15 Nov 2026, seen in the simulation: with the face 15° to
//     one side the robot stood there for ever, too straight to turn and too turned to measure);
//   - head roughly straight and the distance fresh: farther than keep+band → a little forward, nearer than keep−band →
//     a little back; in between, still. The distance counts only with the head about straight: the sensor looks
//     where the head looks, and the body goes where it faces (mod.js lets the wheels go forward only with the head
//     within FORWARD_YAW of the front and still, with a reading taken since).
//   - never forward when something is nearer than stopMm (an obstacle, or the person right there);
//   - no face for lostMs: still. After searchAfterMs with no face (owner, 15 Nov 2026: «se non mi vede il rover deve
//     girarsi finché non mi vede») the body goes looking: short turns on the spot, always the same way, with a pause after
//     each for the camera to look with the body still. The way is the side the face left the picture by (owner, the same
//     day: «se vede la persona che sparisce sulla sinistra deve girarsi a sinistra e viceversa»; `gone`, from
//     live-device.js selfSide: the head stays where it is while the body searches, so the picture's side is the way
//     the turning body must carry it); when that is not clear, the side the head was turned to; or the side of a voice
//     (toward); with none of these, the way of the last time. It stops by itself when the robot
//     falls asleep (mod.js: 30 s with nobody) and never starts in a conversation: `search` says so.
//     Faster since the owner saw it in the simulation («il rover quando gira per cercarmi è troppo lento»): it starts
//     after 3 s (was 5), turns at searchSpeed (the rover's limit, was the 30 % of the other moves) and the first
//     searchQuickSteps pauses are short, enough for the quick pair of detectors only (`quick`; live-device.js gives no
//     frame to the slower one meanwhile). If nobody is found that way the pauses become long enough for the slower
//     detector, which also finds a face seen from below. A face found by a frame whose answer comes when the next turn
//     has begun stops that turn at once.
//   - after any move of its own the next one waits for a face seen with the body still again (the head's yaw of before
//     the move says nothing about where the face is now);
//   - lifted, shaken or fallen: stop.
//
// FASTER (owner, 16 Nov 2026: «ottimizza inseguimento con rover»), measured in the pretend world of
// scripts/sim-follow-world.js, where a person standing 2 m in front was reached in 12 s: every move was a short one
// (0.4 s at 30 %, then a stop, a look, the next), about 8 cm a second. Still never tried with the real rover.
//   - DRIVING instead of steps: forward goes on for as long as the face is in sight, the head is about straight and
//     the sensor still says «far»: every driveMs stretch is renewed renewMs before its end, without stopping (the
//     wheels' timer in rover-wire.js is the dead man: no renewal, and they stop). At fastSpeed (the rover's limit) when
//     more than fastMm from the place to be, at speed for the last stretch. It stops by itself where the sensor says
//     the place is reached (keepMm + arriveMm: the band's far half), not a step later. Never more than driveMaxMs in
//     one go (the rover's own limit for a move), then a look with the wheels still.
//     For this the camera looks while the body goes straight (`look` on the step; mod.js wheelsStill): going forward
//     does not carry the picture sideways as turning does. If the real pictures turn out too shaken to find a face,
//     nothing is renewed and it is the stop-and-look of before, with longer stretches.
//   - STEERING while driving: with the head a little to one side (steerYaw…turnYaw) the body bends that way, at most
//     steer % of turning, so that a person a little off the line is reached without stopping to turn.
//   - TURNS AS WIDE AS NEEDED: a turn lasts what the angle asks (turnShare of the head's yaw, at most turnMaxYaw a
//     time, reckoned with turnRate), at fastSpeed for the wide ones. And the head is told to turn back by as much at
//     the same moment (`head` on the step; mod.js), so that when the body stops the face is in the middle of the
//     picture again instead of at its edge. turnRate IS A GUESS (150° a second at full speed, as the simulation): a
//     real rover twice as quick or half as quick still leaves the face inside the picture, because of turnMaxYaw.
//     Measure it on the real rover and put it here.
//   - FARTHER THAN THE SENSOR SEES: the VL53L0X measures up to 2 m, and a person who walks away is soon beyond that.
//     Until now the body then stood where it was for ever, the face in sight and no distance. Now a fresh reading
//     that says «nothing within my range» (beyond farMm) can count as «far»: with the face in sight and the head about
//     straight the body drives toward it, and the sensor takes over as soon as it sees the person. But «nothing» is
//     also what the sensor says of a person near and a little to one side of its narrow cone (seen in the pretend
//     world: walking round the robot at 1 m, it drove up to 35 cm from them). So «nothing» means «far» only when the
//     sensor had the person at farFromMm or more just before (they walked away), or after farDwellMs of it with the
//     face in sight and the head really straight (within fineYaw); and only until the face is lost or the sensor
//     measures something nearer. A reading that is old, missing or under the sensor's 30 mm is no reason to move.
//     And while the sensor says «nothing» of a person not known to be far, the body turns toward the face until the
//     head is within fineYaw, not only straightYaw: otherwise it could stand for ever with the face 13° to one side,
//     the head «about straight» and the person just outside the sensor's cone (seen in the pretend world).
//
// TURNING WITHOUT STOPS (owner, the same day, seeing the page: «La rotazione possiamo evitare di farla a scatti, ma
// fare magari un continuo»). Still never tried with the real rover.
//   - A TURN TOWARD THE FACE IS ONE MOVE, as wide as the angle (turnShare of it, up to turnAllYaw), not pieces of
//     turnMaxYaw with a look between them. What made the pieces necessary was not knowing how far the body turns in
//     a given time. The robot can measure it: the motion sensor in the head has a gyroscope, and while the body turns
//     on the spot with the head still, what it reads about the vertical is the body's own turn (`spin`, from mod.js:
//     radians a second, without sign: the way is the one the wheels were told). The turn is renewed every
//     spinStretchMs, as the drive, until the measured angle is the wanted one, then stopped; and the head is sent back
//     then, by what the body really turned (`head` on the stop), not by a reckoning at the start. Never longer than
//     turnLongMs: the camera does not look meanwhile, and a person who walks is soon somewhere else.
//     Without a gyroscope reading, or with one that says the body is not turning (under spinTrust of the reckoned
//     rate after spinTrustMs), it is the reckoning of before: turnRate, and no more than turnMaxYaw a time.
//   - THE SEARCH IS ONE SLOW TURN, not steps: at searchSmoothSpeed, renewed for as long as nobody is in sight, with
//     the camera looking meanwhile (`look`; the quick detectors only), stopped at the first face. Whether a face is
//     found in pictures taken while the body turns is NOT KNOWN (it depends on how much they blur): so the turn is
//     kept at searchSmoothRate by the gyroscope (the wheels' speed goes up or down at each renewal, between
//     searchSmoothLeast and fastSpeed, whatever the real rover does at 30 %), and after one
//     whole turn and a bit with nobody (searchSmoothTurn, measured or reckoned) it goes on with the steps and pauses
//     of before, which need no moving picture; and when searchSmoothFails searches in a row ended that way, the slow
//     turn is not tried again until the robot restarts (`searchSmooth` false switches it off altogether).
// Signs as rover-body.js: the head's yaw is positive toward the robot's left, a rover turn z positive toward its right.
export const FOLLOW={keepMm:600,bandMm:150,stopMm:250,turnYaw:20*Math.PI/180,straightYaw:12*Math.PI/180,speed:30,
  backMs:300,restMs:250,freshMs:300,lostMs:800,yawToTurn:-1,
  // Driving forward: fastSpeed is rover-wire.js ROVER_LIMITS.maxSpeed, driveMaxMs its moveMs.
  fastSpeed:50,fastMm:300,driveMs:600,renewMs:200,driveMaxMs:3000,arriveMm:75,steer:12,steerYaw:4*Math.PI/180,
  farMm:2000,farFromMm:1500,farDwellMs:1500,fineYaw:6*Math.PI/180,
  // Turning: nudgeMs the shortest turn, turnMs the longest; turnRate in radians a second at 100 % (a guess).
  nudgeMs:150,turnMs:600,turnRate:150*Math.PI/180,turnShare:.8,turnMaxYaw:25*Math.PI/180,
  // Turning without stops: one stretch, how old a gyroscope reading may be, when and how little of the reckoned rate
  // says «not turning», the fastest turn believed (radians a second), how long before the wanted angle the stop is
  // sent (the reading is up to a tenth of a second old and the wheels take a moment), the widest turn in one move.
  spinStretchMs:400,spinFreshMs:250,spinTrustMs:350,spinTrust:.15,spinMax:400*Math.PI/180,spinLeadMs:80,turnAllYaw:80*Math.PI/180,turnLongMs:1200,
  searchSmooth:true,searchSmoothSpeed:30,searchSmoothRate:45*Math.PI/180,searchSmoothLeast:15,searchSmoothTurn:400*Math.PI/180,searchSmoothMs:15000,searchSmoothFails:2,
  searchAfterMs:3000,searchSpeed:50,searchMs:500,searchRestMs:450,searchQuickSteps:12,searchSlowRestMs:1100,sideYaw:8*Math.PI/180};

// Something in front (owner, 15 Nov 2026: «possiamo fare sensore ostacoli»): the same VL53L0X, on the head, which
// looks where the head looks. True for a fresh reading nearer than stopMm, also one under the sensor's own 30 mm (a thing
// right against it). Nothing in range (8190), an old reading or no sensor: not known, so not an obstacle; the moves
// of following have their own rule above (never forward without a fresh distance). It sees a cone of about 25°
// where the head looks, at the head's height: not the sides, not behind, not the edge of the desk, not something low.
export const obstacleAhead=(distance,now,limits=FOLLOW)=>{
  const age=now-(distance?.at??NaN),mm=distance?.mm;
  return age>=0&&age<=limits.freshMs&&Number.isFinite(mm)&&mm>0&&mm<limits.stopMm;
};

export class RoverFollow{
  #l;#nextAt=0;#movedUntil=-Infinity;#side=1;#blindSince;#urgent=false;#steps=0;#searchFrom;#drive;#farKnown=false;#clearSince;#turn;#sweep;#sweepFails=0;
  constructor(limits=FOLLOW){this.#l={...FOLLOW,...limits};}
  // A voice from that side (1 the robot's left, −1 its right): the search goes that way, and starts at once.
  toward(side){const s=Math.sign(Number(side)||0);if(s)this.#side=s;this.#urgent=true;}
  // Turns made looking for the face since it was last seen (the head keeps to the front meanwhile: live-device.js).
  get steps(){return this.#steps;}
  // The search is in its quick part: short pauses, the quick detectors only.
  get quick(){return this.#steps>0&&this.#steps<=this.#l.searchQuickSteps;}
  // ready: the rover answers; moving: a move is going; unsafe: lifted, shaken or fallen; allowed: switched on and the
  // head may move by itself now; seenMs: since the face was last seen; yaw: the head (radians); distance: the sensor's
  // last {mm,at,valid}; search: it may go looking (camera on, awake, no conversation); gone: the side the face is
  // going to in the picture (1 the robot's left, −1 its right, 0 not clear); still: the head is where its yaw says
  // (false while it is on its way to the face: a turn reckoned on a yaw half way there would be half a turn); spin:
  // the gyroscope's last reading of the turn about the vertical, {rate (radians a second, no sign), at}. Gives {stop:true},
  // {x,y,z,ms,why} (robot's directions, speed in %) or nothing. On a step, `look`: the camera may look during it (the
  // body goes straight, or turns slowly looking for a face); `more`: it renews the move already going. On the stop
  // that ends a turn toward the face, `head`: radians to add to the head's yaw now (the body has turned by as much
  // the other way), `turned`, `ms`, `measured`: how far, in how long, and whether by the gyroscope.
  // The wheels were moved by someone else (voice, iPhone): a drive that was going is no longer this one's to renew.
  release(){this.#drive=undefined;this.#turn=undefined;this.#sweep=undefined;}
  // The slow turn of the search is given up for this run (it found nobody searchSmoothFails times; the steps did).
  get smooth(){return this.#l.searchSmooth&&this.#sweepFails<this.#l.searchSmoothFails;}
  // How far the body has turned in a turn going (t: {from,at,angle,speed,gyro,dead}), by the gyroscope when it can be
  // believed, by the reckoned rate otherwise. spin: {rate,at} or nothing.
  #turned(now,t,spin){
    const l=this.#l,reckoned=l.turnRate*t.speed/100,dt=Math.max(0,now-t.at)/1000,spent=now-t.from;t.at=now;t.dt=dt;
    const age=now-(spin?.at??NaN),read=age>=0&&age<=l.spinFreshMs&&Number.isFinite(spin.rate)&&spin.rate>=0&&spin.rate<=l.spinMax;
    if(read){t.gyro??=0;t.last=spin.rate;}
    if(t.gyro===undefined||t.dead){t.angle=reckoned*spent/1000;t.rate=reckoned;return false;}
    t.rate=read?spin.rate:t.last;t.gyro+=t.rate*dt;
    // Wheels told to turn and a gyroscope that says nothing turns: not believed (and the turn then ends by the clock).
    if(spent>=l.spinTrustMs&&t.gyro<l.spinTrust*reckoned*spent/1000){t.dead=true;t.angle=reckoned*spent/1000;t.rate=reckoned;return false;}
    t.angle=t.gyro;return true;
  }
  #forward(now,ms,mm,yaw,more){
    const l=this.#l,size=Math.abs(yaw),bend=size>l.steerYaw?Math.round(l.steer*Math.min(1,size/l.turnYaw)):0;
    this.#drive.until=now+ms;this.#nextAt=now+ms+l.restMs;
    const step={x:0,y:mm>l.keepMm+l.fastMm?l.fastSpeed:l.speed,z:bend?l.yawToTurn*Math.sign(yaw)*bend:0,ms,why:'closer',look:true};
    if(more)step.more=true;
    return step;
  }
  tick(now,{ready=false,moving=false,unsafe=false,allowed=false,seenMs=Infinity,yaw=0,distance,search=false,gone=0,still=true,spin}={}){
    const l=this.#l,seen=seenMs<l.lostMs;
    if(seen){this.#blindSince=undefined;this.#urgent=false;this.#steps=0;const way=Math.sign(Number(gone)||0);if(way)this.#side=way;else if(Math.abs(yaw)>=l.sideYaw)this.#side=Math.sign(yaw);}
    else if(!search||!allowed||!ready){this.#blindSince=undefined;this.#steps=0;}
    else this.#blindSince??=now;
    if(unsafe){this.#drive=undefined;this.#turn=undefined;this.#sweep=undefined;return moving?{stop:true}:undefined;}
    // A face seen since this search turn began (the answer of a frame taken before it, or, in the slow turn, a frame
    // taken on the way): the turn stops here.
    if(moving&&seen&&this.#searchFrom!==undefined&&now-seenMs>=this.#searchFrom){
      if(this.#sweep)this.#sweepFails=0; // the slow turn does find faces
      this.#searchFrom=undefined;this.#sweep=undefined;this.#movedUntil=now;this.#nextAt=now+l.restMs;return {stop:true,why:'seen'};
    }
    if(!moving){this.#searchFrom=undefined;this.#drive=undefined;this.#turn=undefined;this.#sweep=undefined;}
    if(moving&&this.#turn){
      // Turning toward the face, in one move: on until the body has turned what was wanted, then the head back by as much.
      const t=this.#turn,measured=this.#turned(now,t,spin),want=measured?t.want:t.reckon,spent=now-t.from;
      // Stopped a little before: by the gyroscope its reading's age and the wheels' moment, by the clock one turn of
      // this loop (the next would be past the angle); never before the shortest turn the wheels can make.
      if((spent>=l.nudgeMs&&t.angle+t.rate*(measured?l.spinLeadMs/1000:t.dt)>=want)||spent>=l.turnLongMs){
        this.#turn=undefined;this.#movedUntil=now;this.#nextAt=now+l.restMs;
        return {stop:true,why:'turned',head:-t.way*Math.min(t.size,t.angle),turned:t.angle,ms:spent,measured};
      }
      if(now<t.until-l.renewMs||!ready||!allowed)return;
      const ms=l.spinStretchMs; // the wheels' own timer, should the stop above never be sent
      t.until=now+ms;this.#movedUntil=now+ms;this.#nextAt=now+ms+l.restMs;
      return {x:0,y:0,z:l.yawToTurn*t.way*t.speed,ms,why:'turn',more:true};
    }
    if(moving&&this.#sweep){
      // The slow turn of the search: on while nobody is in sight and the search may go on; after a whole turn with
      // nobody it is left to end, and the steps take over.
      const t=this.#sweep,measured=this.#turned(now,t,spin);
      if(t.angle>=l.searchSmoothTurn||now-t.from>=l.searchSmoothMs){if(!t.over){t.over=true;this.#sweepFails++;}return;}
      if(now<t.until-l.renewMs||!ready||!allowed||!search||seen)return;
      // As fast as the pictures are thought to stand, whatever this rover does at a given speed.
      if(measured&&t.rate>0)t.speed=Math.round(Math.max(l.searchSmoothLeast,Math.min(l.fastSpeed,t.speed*l.searchSmoothRate/t.rate)));
      t.until=now+l.spinStretchMs;this.#movedUntil=t.until;this.#nextAt=t.until+l.searchRestMs;
      return {x:0,y:0,z:l.yawToTurn*t.way*t.speed,ms:l.spinStretchMs,why:'search',look:true,more:true};
    }
    // Fresh: taken in the last freshMs of this same clock (a time from another clock, or from the future, is not).
    const age=now-(distance?.at??NaN),recent=age>=0&&age<=l.freshMs,fresh=!!distance?.valid&&recent,mm=distance?.mm;
    // Nothing within the sensor's range in front (tof-wire.js: 8190 and the like): the way is free. That the person
    // is far, and not just beside the cone, is known as said above.
    const clear=recent&&!distance.valid&&Number.isFinite(mm)&&mm>l.farMm;
    if(!seen){this.#farKnown=false;this.#clearSince=undefined;}
    else if(fresh){this.#farKnown=mm>=l.farFromMm;this.#clearSince=undefined;}
    else if(clear&&Math.abs(yaw)<=l.fineYaw){this.#clearSince??=now;if(now-this.#clearSince>=l.farDwellMs)this.#farKnown=true;}
    else this.#clearSince=undefined;
    const far=fresh||(clear&&this.#farKnown);
    if(moving&&this.#drive){
      // Driving forward. There: stop here. Still far, the face in sight and about in front: on, without stopping.
      const drive=this.#drive;
      if(fresh&&mm<=l.keepMm+l.arriveMm){this.#drive=undefined;this.#nextAt=now+l.restMs;return {stop:true,why:'arrived'};}
      if(now<drive.until-l.renewMs)return;
      const ms=Math.min(l.driveMs,drive.from+l.driveMaxMs-now);
      if(!ready||!allowed||!seen||!far||Math.abs(yaw)>l.turnYaw||ms<=l.renewMs)return; // not renewed: the wheels' own timer stops it
      return this.#forward(now,ms,mm,yaw,true);
    }
    if(!ready||!allowed||moving||now<this.#nextAt)return;
    const rest=(ms,pause=l.restMs)=>{this.#movedUntil=now+ms;this.#nextAt=now+ms+pause;};
    if(!seen){
      // Never seen since the camera began to look (or since a voice woke it): counted from when the search became possible.
      const lostFor=Number.isFinite(seenMs)?Math.min(seenMs,now-this.#blindSince):now-this.#blindSince;
      if(!search||!(this.#urgent||this.#steps>0||lostFor>=l.searchAfterMs))return; // once begun it goes on
      if(this.#steps===0&&this.smooth){
        // One slow turn, the camera looking: counted as the first step (the head stays, the quick detectors only).
        this.#urgent=false;this.#steps=1;rest(l.spinStretchMs,l.searchRestMs);this.#searchFrom=now;
        this.#sweep={from:now,at:now,until:now+l.spinStretchMs,angle:0,speed:l.searchSmoothSpeed,way:this.#side};
        return {x:0,y:0,z:l.yawToTurn*this.#side*l.searchSmoothSpeed,ms:l.spinStretchMs,why:'search',look:true};
      }
      this.#urgent=false;this.#steps++;rest(l.searchMs,this.quick?l.searchRestMs:l.searchSlowRestMs);this.#searchFrom=now;
      return {x:0,y:0,z:l.yawToTurn*this.#side*l.searchSpeed,ms:l.searchMs,why:'search'};
    }
    if(now-seenMs<this.#movedUntil)return; // seen before the body last moved: wait for a look with the body still
    if(!still)return; // the head is on its way: its yaw is not yet where the face is
    if(Math.abs(yaw)>l.straightYaw||(clear&&!this.#farKnown&&Math.abs(yaw)>l.fineYaw)){
      // One move, as wide as the angle asks: by the gyroscope up to turnAllYaw, by the clock up to turnMaxYaw (and
      // never shorter than the shortest turn the wheels can make). The head goes back when it ends («turned» above).
      const size=Math.abs(yaw),way=Math.sign(yaw),speed=size>=l.turnYaw?l.fastSpeed:l.speed,least=l.turnRate*speed/100*l.nudgeMs/1000;
      const ms=l.spinStretchMs;rest(ms);
      this.#turn={from:now,at:now,until:now+ms,angle:0,speed,way,size,want:Math.min(size*l.turnShare,l.turnAllYaw),reckon:Math.max(least,Math.min(size*l.turnShare,l.turnMaxYaw))};
      return {x:0,y:0,z:l.yawToTurn*way*speed,ms,why:'turn'};
    }
    if(!far)return;
    if(mm>l.keepMm+l.bandMm&&mm>l.stopMm){this.#drive={from:now};return this.#forward(now,l.driveMs,mm,yaw,false);}
    // Back in short steps as before (nothing looks behind); the camera may look meanwhile.
    if(fresh&&mm<l.keepMm-l.bandMm){this.#nextAt=now+l.backMs+l.restMs;return {x:0,y:-l.speed,z:0,ms:l.backMs,why:'farther',look:true};}
  }
}
