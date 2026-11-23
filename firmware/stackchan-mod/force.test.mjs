// «Effetto Forza» (force.js): only a quick push is a push; slow hands, held hands and still objects are not.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ForcePush,FORCE,forceMm,forceSteps} from './force.js';
const r=mm=>({mm,valid:mm>=30&&mm<=2000});
// Readings every 50 ms, as the sensor gives them.
const run=(f,list,start=0)=>list.map((mm,i)=>f.feed(r(mm),start+i*50)).filter(Boolean);

test('a quick push from far to close is one push, stronger when faster',()=>{
  const quick=run(new ForcePush(),[600,560,520,480,440,400,360,320,280,250,210,170,150,150]);
  assert.equal(quick.length,1);assert.ok(quick[0].deg>=FORCE.minDeg&&quick[0].deg<=FORCE.maxDeg);
  const fast=run(new ForcePush(),[600,600,140]);
  assert.equal(fast.length,1);assert.ok(fast[0].deg>quick[0].deg,'faster, further back');
  assert.equal(fast[0].deg,FORCE.maxDeg);
});
test('the owner\'s slow approach measured on the robot (about 70 mm/s) is not a push',()=>{
  const slow=[];for(let mm=590;mm>=30;mm-=4)slow.push(mm);
  assert.deepEqual(run(new ForcePush(),slow),[]);
});
test('a hand held close pushes once; it pushes again only after going back and the pause',()=>{
  const f=new ForcePush();
  assert.equal(run(f,[600,200,100,100,100,100]).length,1);
  assert.equal(run(f,[600,150],300).length,0,'too soon');
  assert.equal(run(f,[100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100,100],400).length,0,'still close: no new push');
  assert.equal(run(f,[600,600,150],2000).length,1,'back beyond 29 cm, then quick again');
});
test('below the sensor\'s range is a hand touching it; an object standing still is nothing',()=>{
  assert.equal(forceMm({mm:10,valid:false}),0);assert.equal(forceMm({mm:8190,valid:false}),2000);assert.equal(forceMm(undefined),undefined);
  assert.equal(run(new ForcePush(),[500,300,10]).length,1);
  assert.deepEqual(run(new ForcePush(),Array(40).fill(150)),[]);
  assert.deepEqual(run(new ForcePush(),Array(40).fill(640)),[]);
});
test('«nothing in range» with the hand against the sensor is still close: pulling the hand back is not a push',()=>{
  const f=new ForcePush();
  assert.equal(run(f,[600,560,520,480,440,400,360,320,280,250,210,170,130,90,50,31]).length,1);
  // The hand stays against it (tof-wire.js gives the last near distance, near:true), then is pulled back after the pause.
  const near={mm:31,valid:false,near:true,raw:8190};
  assert.equal([near,near].map((x,i)=>f.feed(x,2000+i*50)).filter(Boolean).length,0);
  assert.equal(run(f,[34,65,85,133,177,219,259,308],2100).length,0);
  // Something close all at once from nothing in range (8190) is not a push: it came in from the side, or the head
  // turned onto it (21 Nov 2026, scared faces with nobody pushing). A hand first measured far, then close, is.
  assert.equal(run(new ForcePush(),[8190,8190,8190,150]).length,0);
  assert.equal(run(new ForcePush(),[8190,8190,400,150]).length,1);
});
test('the recoil throws the head back (up) and brings it home',()=>{
  const s=forceSteps(20);assert.equal(s[0].pitch,-20);assert.equal(s.at(-1).pitch,0);assert.ok(s.every(x=>x.yaw===0));
});
test('the owner\'s real pushes at the first try (19 Nov 2026, 23:26) are pushes; the slow approach still is not',()=>{
  // Readings from the robot's log (ms from the first, mm), filled in every 50 ms as the sensor reads.
  const fill=points=>{const out=[];for(let t=0;t<=points.at(-1)[0];t+=50){const i=points.findIndex(p=>p[0]>=t),[t1,m1]=points[i],[t0,m0]=points[Math.max(0,i-1)];out.push(t1===t0?m1:Math.round(m0+(m1-m0)*(t-t0)/(t1-t0)));}return out;};
  const tries=[
    [[0,291],[212,262],[528,218],[844,182],[1102,161]],
    [[0,320],[280,239],[400,219],[600,182],[800,155]],
    [[0,317],[200,276],[479,245],[600,216],[900,185],[1280,153]],
  ];
  for(const t of tries)assert.equal(run(new ForcePush(),fill(t)).length,1,JSON.stringify(t[0]));
  // One try came at about 90 mm/s, as slow as a hand that just comes closer: that one cannot be a push.
  assert.equal(run(new ForcePush(),fill([[0,298],[224,268],[421,245],[621,225],[921,205],[1222,175],[1521,141]])).length,0);
  const slow=[];for(let mm=590;mm>=30;mm-=4)slow.push(mm);
  assert.deepEqual(run(new ForcePush(),slow),[],'about 80 mm/s');
});
import {WaveWatch,WAVE} from './force.js';
test('«Saluto» never with nobody waving (21 Nov 2026, «controlla come mai mi continua a salutare»): every reading of two minutes on the robot, 7 hellos before, none now',()=>{
  // The robot's «tof raw» lines: [ms of the line, readings of the second before it] (0 = nothing in range). A gap of
  // more than 1.5 s between lines was nothing in range.
  const lines=[
  [2852762,"428"],
  [2853818,"437,418,345,532,527,549,558,530,547,555,534,545,543,530,541,550"],
  [2854990,"535,551,532,550,541,552,546,545,536,551,555"],
  [2855880,"551,520,551,381,413,447,456,426,427,404"],
  [2856880,"370,360,394,393,399,390,410,402,410"],
  [2857971,"395,400,402,400,409,416,424,398,418"],
  [2859146,"413,417,425,418,420,425,426,417,0"],
  [2866695,"0,0,0,555,593,598,596,594,595,600,618"],
  [2867682,"592,602,605,601,593,604,602,603"],
  [2868771,"586,548,565,572,553,569,586,592,563"],
  [2869824,"556,572,550,574,566,574,540,561,558,549"],
  [2870855,"576,574,599,568,538,532,511,541,540,539"],
  [2872097,"591,573,591,0,132,57,90,581,570,0"],
  [2880747,"0,0,0,0,541,524,0,271"],
  [2881797,"0,290,0,0,0,0,277,264,0"],
  [2882835,"0,0,282,253,343,0,310,232,232,232"],
  [2884028,"232,0,0,0,0,0,0,0,0,0,0"],
  [2905895,"0,0,0,0,242,206,199,191,193,197"],
  [2906894,"196,190,198,196,199,195,196,201,204,204"],
  [2907919,"200,194,200,199,205,198,203,219,270"],
  [2908941,"247,241,230,250,249,244,255,235,262"],
  [2910028,"258,255,266,239,257,253,252,243,262,276"],
  [2911126,"261,258,248,266,252,277,0,0,0,0"],
  [2954301,"0,0,0,0,605,564,608,594,612,615"],
  [2955354,"597,604,611,613,627,600,579,600,606"],
  [2956399,"603,628,609,619,616,604,589,596,568,582,577"],
  [2957393,"594,558,578,581,582,584,598"],
  [2958442,"594,588,569,571,588,567,589,589,568"],
  [2959469,"569,591,554,574,576,562,589,593,567,586"],
  [2960488,"586,577,589,590,587,581,580,580,589,574,591"],
  [2961596,"587,579,580,597,576,591,572,601,579,579"],
  [2962672,"580,577,593,566,554,581,579,582,570,573"],
  ];
  const f=new WaveWatch(),got=[];let last;
  for(const [at,text] of lines){
    const list=text.split(',').map(Number),step=1000/list.length;
    if(last!==undefined&&at-last>1500)got.push(...[f.feed(r(8190),last+500)].filter(Boolean));
    list.forEach((mm,i)=>{const x=f.feed(r(mm||8190),at-(list.length-1-i)*step);if(x)got.push(x);});last=at;
  }
  assert.deepEqual(got,[]);
});
test('«Saluto» from every reading of the owner\'s hand (19 Nov 2026, 23:52): three waves are three hellos; the hand held still, an approach, noise are none',()=>{
  // Every reading, as the robot read them (about one each 100 ms).
  const run10=(f,list,start=0)=>list.map((mm,i)=>f.feed(r(mm),start+i*100)).filter(Boolean);
  const waves=[
    [400,417,374,351,390,388,372,404,373,353,376,365,356,351,372,349,341,372,362,351,353,347,321,326,360,341,327,353,335,321,330,360,355,327,356,374,357,344,362,357,345,321,394],
    [366,356,339,346,342,318,308,354,348,329,345,346,320,307,331,335,314,340,316,322,328,309,335,338,316,323,345,317,319,348,344,315,336,324,296,332,335,350,323],
    [329,367,390,357,319,357,344,335,354,347,317,319,336,331,351,344,325,300,324,360,322,338,336,331,327,362,329,323,327,331,338,328,372],
  ];
  for(const [i,w] of waves.entries())assert.equal(run10(new WaveWatch(),[...Array(10).fill(8190),...w,...Array(10).fill(8190)]).length,1,'wave '+(i+1));
  const f=new WaveWatch({...WAVE,coolMs:4000});let t=0;const got=[];
  for(const w of waves){got.push(run10(f,[...Array(20).fill(8190),...w,...Array(20).fill(8190)],t).length);t+=(w.length+40)*100;}
  assert.deepEqual(got,[1,1,1],'one after the other, as the owner did, 4 s apart allowed: three hellos');
  // Since 23 Nov 2026 one hello in 2 minutes: the second and third wave of the owner are not answered, one after is.
  const g=new WaveWatch();t=0;const kept=[];
  for(const w of [...waves,waves[0]]){kept.push(run10(g,[...Array(20).fill(8190),...w,...Array(20).fill(8190)],t).length);t+=(w.length+40)*100;}
  assert.deepEqual(kept,[1,0,0,0],'within 2 minutes: once');
  assert.equal(run10(g,[...Array(20).fill(8190),...waves[0]],120000).length,1,'2 minutes later: again');
  const still=[314,314,305,305,293,298,297,282,279,280,278,285,282,283,285,282,283,283,280,283,278,283,281,283,286,274,276,279,281,285,286,286,287,291,285,289,282,285,288,293,285,290,286,287,287,292,288,289,291,286,286,280,292,287,290,290,286,289,296,294,301,305,321];
  assert.equal(run10(new WaveWatch(),still).length,0,'the hand held still');
  const quick=[];for(let mm=590;mm>=60;mm-=25)quick.push(mm);
  assert.equal(run10(new WaveWatch(),quick).length,0,'a hand coming closer quickly, one way');
  let seed=7;const rnd=()=>((seed=(seed*1103515245+12345)%2147483648)/2147483648);
  const noise=[];for(let i=0;i<600;i++)noise.push(400+Math.round((rnd()*2-1)*8));
  assert.equal(run10(new WaveWatch(),noise).length,0,'noise of ±8 mm, twice the still hand');
  // 23 Nov 2026, the owner sitting still at 40 cm: up and down at every reading, 20 mm and more, nearly the same two
  // readings apart. Four hellos in 20 s before; none now. The three waves above still are three.
  const sitting=[400,420,389,410,433,401,421,400,420,400,423,401,379,414,437,407,434,402,424,398,420,396,424,394,425,375,422,402,425,385,419,394,420,397,421,394,419,393,417,395];
  assert.equal(run10(new WaveWatch(),sitting).length,0,'someone sitting at 40 cm');
  const f2=new WaveWatch();assert.equal(run10(f2,waves[0]).length,1);assert.match(f2.last,/^\d+(,\d+){11}$/,'the 12 readings of the hello, for the log');
});
test('the owner\'s pushes of 23 Nov 2026: a hand that stops at 23 cm is a push; one that comes close while the robot was busy for 2 s too',()=>{
  // 20:36:33-34: 569, 295, 236 mm.
  assert.equal(run(new ForcePush(),[569,569,295,236,236]).length,1,'stopped at 23 cm');
  // 20:37:44-46: 653 mm, then nothing for 2 s (a conversation opening), then 130 mm.
  const f=new ForcePush();assert.equal(f.feed(r(653),0),undefined);assert.ok(f.feed(r(130),2000),'after the gap');
  // A gap too long is no push: who knows what happened meanwhile.
  const g=new ForcePush();g.feed(r(653),0);assert.equal(g.feed(r(130),3000),undefined);
  // Nor a hand held at 30 cm that wobbles a little.
  assert.deepEqual(run(new ForcePush(),[300,290,300,295,288,300,292,296,290,299]),[]);
});
