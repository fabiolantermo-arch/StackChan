// Original Robottino face, 320x240 design space. Pure geometry shared by Piu and preview.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number.isFinite(v)?v:a));
export function faceGeometry({gazeX=0,gazeY=0,open=1,mouth=0,emotion=0,time=0}={}){
  const x=clamp(gazeX,-1,1)*12,y=clamp(gazeY,-1,1)*7;
  const phase=time%4700,blink=phase>4400?Math.abs((phase-4550)/150):1;
  const eyelid=clamp(open,0,1)*clamp(blink,0,1),happy=emotion===3,sad=emotion===2;
  const parts=[];
  const add=(id,x,y,w,h,r,color)=>parts.push({id,x:Math.round(x),y:Math.round(y),w:Math.max(2,Math.round(w)),h:Math.max(2,Math.round(h)),r,color});
  add('panel',12,15,296,210,32,'#101d30');
  for(const [side,cx]of [['left',98],['right',222]]){
    const h=8+64*eyelid;
    add(side+'-white',cx-36,102-h/2,72,h,Math.min(23,h/2),'#edfbff');
    if(eyelid>.25){
      const ih=Math.min(42,h-5);
      add(side+'-iris',cx-20+x,102-ih/2+y*eyelid,40,ih,Math.min(17,ih/2),'#39cbbb');
      add(side+'-pupil',cx-10+x,91+y*eyelid,20,Math.min(27,ih-4),9,'#07101f');
      add(side+'-glint',cx-13+x,89+y*eyelid,9,8,4,'#ffffff');
    }
    add(side+'-brow',cx-28,49+(sad?(side==='left'?8:0):happy?-5:0),56,6,3,'#69dfd1');
    add(side+'-cheek',cx-23,148,46,9,4,happy?'#e98d9e':'#354658');
  }
  const m=clamp(mouth,0,1),mw=happy?76:60,mh=7+38*m;
  add('mouth-border',160-mw/2-3,175-mh/2-3,mw+6,mh+6,Math.min(18,(mh+6)/2),'#69dfd1');
  add('mouth',160-mw/2,175-mh/2,mw,mh,Math.min(16,mh/2),'#070d1a');
  if(m>.3)add('tongue',143,175+mh/2-10,34,8,4,'#ed859b');
  return parts;
}
