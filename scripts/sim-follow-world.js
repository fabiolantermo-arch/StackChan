// The pretend world of «Inseguimento con rover e testa»: a room, a person, the robot's body, head, camera and distance
// sensor. The deciding is not here: it is the robot's own rover-follow.js, given from outside. One file for the page
// (scripts/sim-follow.mjs puts it inside the page) and for the measurements (rover-follow.test.mjs), so the numbers
// in the diary are those of the page the owner looks at.
// Everything here is an assumption until the real rover is measured (SIM.fullSpeed, SIM.fullTurn above all).
export const SIM={roomW:4.5,roomH:3.2,fov:58*Math.PI/180,faceMax:3.0,tofCone:25*Math.PI/180,
  // Assumptions to be measured on the real rover: speed at 100 % and turning rate at 100 %.
  fullSpeed:0.5,fullTurn:150*Math.PI/180,headStep:0.9,headLimit:90*Math.PI/180,cycleMs:50,
  // The camera, as measured on the robot (15 Nov 2026: 13-20 pictures in 5 s): one picture every frameMs when it may
  // look; none while the head moves and for headSettleMs after (mod.js headSettled), none while the wheels turn the
  // body and for cameraAfterMs after (mod.js wheelsStill). headMoveMs: the head is on its way (mod.js headMoving).
  frameMs:300,headSettleMs:330,headMoveMs:200,headDeadband:.05,cameraAfterMs:250,sleepMs:30000,
  // true: the pictures taken while the body drives straight are too shaken to find a face (not known until the real
  // rover is tried): the camera looks only with the wheels still, whatever the step says.
  blindDrive:false,
  // The gyroscope in the head (mod.js roverSpin): a reading every gyroMs of how fast the body really turns. false:
  // none, the turns are reckoned by the clock. turnSightRate: the camera finds a face while the body turns no faster
  // than this (radians a second); how much blur the real detector stands is not known.
  gyro:true,gyroMs:100,turnSightRate:60*Math.PI/180};
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
// RoverFollow, FOLLOW: the robot's own (rover-follow.js). sim: other assumptions. Gives the world: step() moves it
// on by one robot cycle and says what happened.
export function createWorld({RoverFollow,FOLLOW,sim=SIM,limits}){
  const S={...SIM,...sim};
  const robot={x:1.2,y:1.6,h:0,yaw:0},person={x:2.6,y:1.0},follow=new RoverFollow(limits);
  let now=0,lastSeen=-Infinity,frameAt=-Infinity,headUntil=-Infinity,move=null,turnedAt=-Infinity,aloneFrom=0,asleep=false,gone=0,drift=0,headMovedAt=-Infinity,spin,spinAt=-Infinity;
  const bearing=()=>wrap(Math.atan2(-(person.y-robot.y),person.x-robot.x)-robot.h); // the robot's left positive
  const range=()=>Math.hypot(person.x-robot.x,person.y-robot.y);
  const head=to=>{const next=Math.max(-S.headLimit,Math.min(S.headLimit,to));if(Math.abs(next-robot.yaw)>=1e-9){robot.yaw=next;headMovedAt=now;headUntil=now+S.headSettleMs;}};
  return {robot,person,follow,sim:S,bearing,range,get now(){return now;},get asleep(){return asleep;},
    step(){
      now+=S.cycleMs;const events=[];
      // The picture is still enough during this move: going straight, or turning slowly looking for a face.
      const still=m=>m.look&&!S.blindDrive&&Math.abs(S.fullTurn*m.z/100)<=S.turnSightRate;
      if(move&&now>=move.until){if(!still(move))turnedAt=now;move=null;}
      const b=bearing(),d=range();
      // The camera: a face inside its view, one picture every frameMs, only with the picture still.
      const looking=(!move||still(move))&&now-turnedAt>=S.cameraAfterMs&&now>=headUntil;
      const inView=d<S.faceMax&&Math.abs(wrap(b-robot.yaw))<S.fov/2;
      let seen=false;
      if(looking&&now-frameAt>=S.frameMs){
        frameAt=now;
        if(inView){
          seen=true;lastSeen=now;aloneFrom=now;
          // As live-device.js selfSide: where the face is off the middle of the picture is the way it is going.
          const off=-wrap(b-robot.yaw)/S.fov;drift=drift*.5+off*.5;const way=Math.abs(off)>=.12?off:drift;gone=way<=-.12?1:way>=.12?-1:0;
          // The head: toward the face, most of the way; a face near the middle leaves it where it is (tracker.js).
          const error=wrap(b-robot.yaw);if(Math.abs(error)>S.headDeadband)head(robot.yaw+S.headStep*error);
        }
      }
      const sleeping=now-aloneFrom>=S.sleepMs;
      if(sleeping!==asleep){asleep=sleeping;events.push(asleep?'sleep':'wake');if(asleep)robot.yaw=0;}
      // The VL53L0X looks where the body looks: the person only inside its cone, up to 2 m.
      const inCone=Math.abs(b)<S.tofCone/2,mm=Math.round(d*1000);
      const distance=inCone&&mm<=2000?{mm,at:now,valid:mm>=30}:{mm:8190,at:now,valid:false};
      // The gyroscope: what the body turns now, read every gyroMs, and not while the head moves (mod.js roverSpin).
      if(S.gyro&&now-spinAt>=S.gyroMs){spinAt=now;spin={rate:move?Math.abs(S.fullTurn*move.z/100):0,at:now};}
      const steady=now-headMovedAt>=S.headMoveMs;
      const action=follow.tick(now,{ready:true,moving:!!move,unsafe:false,allowed:true,seenMs:now-lastSeen,yaw:robot.yaw,distance,search:!asleep,gone,still:steady,spin:S.gyro&&steady?spin:undefined});
      if(action?.stop&&move){
        if(!still(move))turnedAt=now;move=null;events.push({stop:action.why??'stop',turned:action.turned,measured:action.measured});
        // The head told to turn back by as much as the body has turned (mod.js, the stop's `head`).
        if(action.head)head(robot.yaw+action.head);
      }
      if(action&&!action.stop){
        move={...action,until:now+action.ms};
        if(!action.more)events.push({move:action,mm:distance.mm});
      }
      if(move){
        const dt=S.cycleMs/1000,room=move.z?(100-Math.abs(move.z))/100:1; // rover-wire.js wheelSpeeds: turning takes room from the rest
        const v=S.fullSpeed*move.y*room/100,w=-S.fullTurn*move.z/100; // z>0 turns to the robot's right
        robot.x+=Math.cos(robot.h)*v*dt;robot.y-=Math.sin(robot.h)*v*dt;robot.h=wrap(robot.h+w*dt);
        robot.x=Math.max(.2,Math.min(S.roomW-.2,robot.x));robot.y=Math.max(.2,Math.min(S.roomH-.2,robot.y));
      }
      return {now,seen,inView,inCone,distance,range:d,move,asleep,gone,events,lastSeen};
    }};
}
